import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { WorkItem } from "../src/core/types.js";
import { parseVerdict } from "../src/core/verdict.js";
import type { AuthAction, Principal } from "../src/interfaces/auth-provider.js";
import type { SourceEvent, VerdictEventTarget } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, mallory, silent } from "./helpers/fakes.js";
import { newStore, system, PROJECT_KEY } from "./helpers/store.js";

describe("parseVerdict", () => {
  it("reads the verdict, the severity and the reason (following lines included)", () => {
    expect(parseVerdict("changes major rename the flag\nand add a test")).toEqual({
      ok: true,
      value: { verdict: "changes", severity: "major", reason: "rename the flag\nand add a test" },
    });
    expect(parseVerdict("reject critical  wrong approach ")).toEqual({
      ok: true,
      value: { verdict: "reject", severity: "critical", reason: "wrong approach" },
    });
  });

  it("lets accept omit the reason", () => {
    expect(parseVerdict("accept none")).toEqual({ ok: true, value: { verdict: "accept", severity: "none", reason: null } });
    expect(parseVerdict("accept minor nit in a comment")).toMatchObject({ ok: true, value: { reason: "nit in a comment" } });
  });

  it("refuses changes and reject without a reason", () => {
    expect(parseVerdict("changes minor")).toEqual({ ok: false, refuse: "`changes` needs a reason after the severity" });
    expect(parseVerdict("reject major\n  ")).toEqual({ ok: false, refuse: "`reject` needs a reason after the severity" });
  });

  it("refuses an unknown severity, naming the allowed ones", () => {
    const r = parseVerdict("changes huge rename it");
    expect(r).toEqual({ ok: false, refuse: "severity `huge` is not one of `none`, `minor`, `major`, `critical`" });
  });

  it("refuses a missing or unknown verdict word, or missing arguments, with the expected format", () => {
    for (const args of ["", "accept", "approve none fine", "ACCEPT none"]) {
      const r = parseVerdict(args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refuse).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
    }
  });
});

/** Records every authorize call, else as FakeAuth. */
class SpyAuth extends FakeAuth {
  actions: AuthAction[] = [];
  override async authorize(p: Principal, action: AuthAction) {
    this.actions.push(action);
    return super.authorize(p, action);
  }
}

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const auth = new SpyAuth();
  const controller = new Controller({ store, source, auth, clock, config, log: silent, scanner: cleanScanner });
  return { store, source, auth, controller };
}
type F = Awaited<ReturnType<typeof setup>>;

/** Issue #7 as a work item; with `pr`, in REVIEW waiting for a merge of PR #42. */
async function item(f: F, pr = true): Promise<WorkItem> {
  const { item } = await f.store.createWorkItem(
    { source: issueRef(7), requester_id: "github:1" as WorkItem["requester_id"], project: PROJECT_KEY, problem: "p", resources: [] },
    system,
  );
  if (!pr) return item;
  const r = await f.store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "test",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

const onIssue: VerdictEventTarget = { kind: "issue", source: issueRef(7) };
const verdict = (args: string, comment_id = "500", target: VerdictEventTarget = onIssue, approver = alice): SourceEvent => ({
  kind: "verdict_submitted", target, comment_id, approver, args,
});

describe("controller: /verdict", () => {
  it("stores one verdict from a writer on the issue, as that user, without changing stage or blocking", async () => {
    const f = await setup();
    const before = await item(f);
    await f.controller.handleEvent(verdict("changes minor rename the flag\nplease"));

    const after = (await f.store.getWorkItem(before.id))!;
    expect(after).toMatchObject({ version: before.version + 1, stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const sc = (await f.store.listStateChanges(before.id)).at(-1)!;
    expect(sc).toMatchObject({ reason: "human_verdict", actor: { kind: "user", id: "github:1" }, changes: {} });
    expect(await f.store.listVerdicts(before.id)).toEqual([
      expect.objectContaining({
        state_change_id: sc.id, verdict: "changes", severity: "minor", reason: "rename the flag\nplease",
        comment_id: "500", target: "issue",
      }),
    ]);
    expect(f.auth.actions).toEqual(["record_verdict"]);
    expect(f.source.reactions).toEqual([{ source: issueRef(7), comment_id: "500" }]);
    expect(f.source.comments).toEqual([]);
    expect(f.source.statusCalls).toEqual([]);
  });

  it("stores a verdict written on the item's PR the same way", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept none", "501", { kind: "pr", pr_number: 42, head_branch: `factory/${it0.id}` }));
    expect(await f.store.listVerdicts(it0.id)).toEqual([
      expect.objectContaining({ verdict: "accept", severity: "none", reason: null, comment_id: "501", target: "pr" }),
    ]);
    expect((await f.store.listStateChanges(it0.id)).at(-1)).toMatchObject({ reason: "human_verdict", actor: { id: "github:1" } });
    expect(f.source.comments).toEqual([]);
  });

  it("ignores a PR comment whose branch is not a work item's, or whose PR is not the item's", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept none", "502", { kind: "pr", pr_number: 42, head_branch: "factory/wi_nope" }));
    await f.controller.handleEvent(verdict("accept none", "503", { kind: "pr", pr_number: 41, head_branch: `factory/${it0.id}` }));
    await f.controller.handleEvent(verdict("accept none", "504", { kind: "issue", source: issueRef(8) }));
    expect(await f.store.listVerdicts(it0.id)).toEqual([]);
    expect(f.source.comments).toEqual([]);
    expect(f.source.reactions).toEqual([]);
  });

  const refused = async (f: F, it0: WorkItem, comment_id: string) => {
    expect(await f.store.listVerdicts(it0.id)).toEqual([]);
    expect(await f.store.getWorkItem(it0.id)).toEqual(it0);
    const replies = f.source.comments.filter((c) => c.marker === `<!-- factory:refused:${comment_id} -->`);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.source).toEqual(issueRef(7));
    return replies[0]!.body;
  };

  it("refuses changes and reject without a reason", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("changes minor", "510"));
    await f.controller.handleEvent(verdict("reject major", "511"));
    expect(await refused(f, it0, "510")).toBe("`/verdict` was not applied: `changes` needs a reason after the severity.");
    expect(await refused(f, it0, "511")).toContain("`reject` needs a reason");
  });

  it("refuses an unknown severity with one reply that states it", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("changes huge rename it", "512"));
    expect(await refused(f, it0, "512")).toContain("severity `huge` is not one of `none`, `minor`, `major`, `critical`");
  });

  it("refuses a missing or unknown verdict word with the expected format", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("", "513"));
    await f.controller.handleEvent(verdict("lgtm none", "514"));
    for (const id of ["513", "514"]) {
      expect(await refused(f, it0, id)).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
    }
  });

  it("refuses a user without write permission", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept none", "515", onIssue, mallory));
    expect(await refused(f, it0, "515")).toContain("needs write permission");
  });

  it("refuses a verdict on a CLOSED item, and on an item with no PR yet", async () => {
    const f = await setup();
    const noPr = await item(f, false);
    await f.controller.handleEvent(verdict("accept none", "516"));
    expect(await refused(f, noPr, "516")).toContain("no PR yet");

    const closed = await f.store.transition({
      id: noPr.id, expected_version: noPr.version, actor: system, reason: "test",
      patch: { stage: "CLOSED", close_reason: "wont_do", pr_number: 42 },
    });
    if (!closed.ok) throw new Error(closed.reason);
    await f.controller.handleEvent(verdict("accept none", "517"));
    expect(await refused(f, closed.item, "517")).toContain("the work item is closed");
  });

  it("stores a redelivered verdict comment once and posts no reply, even after the item closed", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("reject critical wrong approach", "520"));
    await f.controller.handleEvent(verdict("reject critical wrong approach", "520"));
    await f.store.transition({
      id: it0.id, expected_version: it0.version + 1, actor: system, reason: "test", patch: { stage: "CLOSED", close_reason: "rejected" },
    });
    await f.controller.handleEvent(verdict("reject critical wrong approach", "520"));
    expect(await f.store.listVerdicts(it0.id)).toHaveLength(1);
    expect((await f.store.listStateChanges(it0.id)).filter((c) => c.reason === "human_verdict")).toHaveLength(1);
    expect(f.source.comments).toEqual([]);
  });

  it("posts one reply for a refused comment delivered twice", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("changes minor", "521"));
    await f.controller.handleEvent(verdict("changes minor", "521"));
    await refused(f, it0, "521");
    expect(f.source.comments).toHaveLength(1);
  });
});
