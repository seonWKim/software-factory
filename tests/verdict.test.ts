import { OwnerAuth } from "../src/core/authorize.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItem, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { parseVerdict, verdictRefusal } from "../src/core/verdict.js";
import { LocalSource } from "../src/impl/source/local-source.js";
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

  it("lets accept omit the severity too: it is then none, and any text after accept is the reason", () => {
    for (const args of ["accept", " accept \n"]) {
      expect(parseVerdict(args)).toEqual({ ok: true, value: { verdict: "accept", severity: "none", reason: null } });
    }
    expect(parseVerdict("accept looks good\nthanks")).toEqual({
      ok: true, value: { verdict: "accept", severity: "none", reason: "looks good\nthanks" },
    });
  });

  it("reads yes and ok as accept", () => {
    for (const word of ["yes", "ok"]) {
      expect(parseVerdict(word)).toEqual(parseVerdict("accept"));
      expect(parseVerdict(`${word} minor a nit`)).toEqual({ ok: true, value: { verdict: "accept", severity: "minor", reason: "a nit" } });
    }
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
    for (const args of ["", "changes", "reverted major undo", "approve none fine", "ACCEPT none", "lgtm"]) {
      const r = parseVerdict(args);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refuse).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
        expect(r.refuse).toContain("`yes` and `ok` mean `accept`");
      }
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
  const controller = new ControllerRole({ store, source, auth, clock, config, log: silent, scanner: cleanScanner });
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
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" },
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
    await f.controller.handleEvent(verdict("accept none", "501", { kind: "pr", change_ref: "42", head_branch: `factory/${it0.id}` }));
    expect(await f.store.listVerdicts(it0.id)).toEqual([
      expect.objectContaining({ verdict: "accept", severity: "none", reason: null, comment_id: "501", target: "pr" }),
    ]);
    expect((await f.store.listStateChanges(it0.id)).at(-1)).toMatchObject({ reason: "human_verdict", actor: { id: "github:1" } });
    expect(f.source.comments).toEqual([]);
  });

  it("ignores a PR comment whose branch is not a work item's, or whose PR is not the item's", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept none", "502", { kind: "pr", change_ref: "42", head_branch: "factory/wi_nope" }));
    await f.controller.handleEvent(verdict("accept none", "503", { kind: "pr", change_ref: "41", head_branch: `factory/${it0.id}` }));
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

  it("refuses a missing or unknown verdict word with the usage line, and stores nothing", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("", "513"));
    await f.controller.handleEvent(verdict("lgtm none", "514"));
    for (const id of ["513", "514"]) {
      expect(await refused(f, it0, id)).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
    }
    expect((await f.store.listStateChanges(it0.id)).some((c) => c.reason === "human_verdict")).toBe(false);
  });

  it("records `/verdict accept` alone as severity none, and `/verdict yes` and `/verdict ok` the same", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept", "530"));
    await f.controller.handleEvent(verdict("yes", "531"));
    await f.controller.handleEvent(verdict("ok", "532"));
    expect((await f.store.listVerdicts(it0.id)).map((v) => [v.comment_id, v.verdict, v.severity, v.reason, v.implicit])).toEqual([
      ["530", "accept", "none", null, false],
      ["531", "accept", "none", null, false],
      ["532", "accept", "none", null, false],
    ]);
    expect(f.source.comments).toEqual([]);
  });

  it("refuses a user without write permission", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(verdict("accept none", "515", onIssue, mallory));
    expect(await refused(f, it0, "515")).toContain("needs write permission");
  });

  it("refuses a verdict on a closed item whose PR was not merged, with one reply, and on an item with no PR yet", async () => {
    const f = await setup();
    const noPr = await item(f, false);
    await f.controller.handleEvent(verdict("accept none", "516"));
    expect(await refused(f, noPr, "516")).toContain("no PR yet");

    const closed = await f.store.transition({
      id: noPr.id, expected_version: noPr.version, actor: system, reason: "test",
      patch: { stage: "CLOSED", close_reason: "rejected", change_ref: "42" },
    });
    if (!closed.ok) throw new Error(closed.reason);
    await f.controller.handleEvent(verdict("accept none", "517"));
    await f.controller.handleEvent(verdict("accept none", "517"));
    expect(await refused(f, closed.item, "517")).toBe("`/verdict` was not applied: the work item is closed and its PR was not merged.");
  });

  it("records a verdict on a merged item", async () => {
    const f = await setup();
    const it0 = await item(f);
    const merged = await f.store.transition({
      id: it0.id, expected_version: it0.version, actor: system, reason: "pr_merged",
      patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "m1", blocked_on: "none", blocked_reason: null },
    });
    if (!merged.ok) throw new Error(merged.reason);
    await f.controller.handleEvent(verdict("changes major the flag name is wrong", "533"));
    expect(await f.store.listVerdicts(it0.id)).toEqual([expect.objectContaining({ verdict: "changes", severity: "major", implicit: false })]);
    expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", version: merged.item.version + 1 });
    expect(f.source.comments).toEqual([]);
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

describe("verdictRefusal", () => {
  it("refuses a closed item that was not merged, saying so when it had a PR; an open or merged item takes a verdict", () => {
    expect(verdictRefusal({ stage: "CLOSED", merge_sha: null, change_ref: null })).toBe("the work item is closed");
    expect(verdictRefusal({ stage: "CLOSED", merge_sha: null, change_ref: "42" })).toBe("the work item is closed and its PR was not merged");
    expect(verdictRefusal({ stage: "CLOSED", merge_sha: "m1", change_ref: "42" })).toBeNull();
    expect(verdictRefusal({ stage: "REVIEW", merge_sha: null, change_ref: null })).toBeNull();
  });

  it("is the one place the closed-item text lives: the verdict unit calls it and keeps no copy", () => {
    const unit = readFileSync(new URL("../src/controller/units/verdicts/verdicts.unit.ts", import.meta.url), "utf8");
    expect(unit).toContain("verdictRefusal(");
    expect(unit).not.toContain("the work item is closed");
  });
});

describe("factory verdict on a local item (issue #523)", () => {
  const ME = "local:me@example.com" as UserId;
  const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

  /** No forge and no account: the local source, the local auth plugin, and the CLI as ME, who becomes the local owner. */
  async function local() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth: new OwnerAuth({ store: store, claimer: null }), clock, config, log: silent, scanner: cleanScanner,
      repeated_failure_rule: false,
    });
    let n = 0;
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "b", newId: () => `id${++n}` };
    /** A local item filed from the CLI, put at `patch`. */
    const filed = async (patch: WorkItemPatch): Promise<WorkItem> => {
      const id = (await runLocalCli(d, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
      const it = (await store.getWorkItem(id))!;
      const r = await store.transition({ id, expected_version: it.version, actor: system, reason: "test_setup", patch });
      if (!r.ok) throw new Error("setup");
      return r.item;
    };
    const cli = (id: WorkItemId, text: string) => runLocalCli(d, { action: "command", command: "verdict", id, text });
    const shape = async (id: WorkItemId) => (await store.listVerdicts(id)).map((v) => ({
      verdict: v.verdict, severity: v.severity, reason: v.reason, target: v.target, implicit: v.implicit, pr_head: v.pr_head,
    }));
    return { store, controller, filed, cli, shape };
  }

  it("stores one command row; the controller stores the same verdict a `/verdict` comment on the item does, and changes no state", async () => {
    const f = await local();
    const byCli = await f.filed(MERGE_PENDING);
    const byComment = await f.filed(MERGE_PENDING);
    const before = await f.store.listCliCommandsAfter(0, 100);
    const r = await f.cli(byCli.id, "changes major rename the flag");
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain(`stored \`/verdict\` for ${byCli.id} as ${ME}`);
    const rows = (await f.store.listCliCommandsAfter(0, 100)).slice(before.length);
    expect(rows.map((c) => ({ command: c.command, args: c.args }))).toEqual([{ command: "verdict", args: { item: byCli.id, text: "changes major rename the flag" } }]);

    await f.controller.tickCommands();
    await f.controller.handleEvent(verdict("changes major rename the flag", "900", { kind: "issue", source: byComment.source }, { provider: "local", subject: "me@example.com" }));

    expect(await f.shape(byCli.id)).toEqual([{ verdict: "changes", severity: "major", reason: "rename the flag", target: "issue", implicit: false, pr_head: null }]);
    expect(await f.shape(byCli.id)).toEqual(await f.shape(byComment.id));
    for (const it of [byCli, byComment]) {
      expect(await f.store.getWorkItem(it.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", version: it.version + 1 });
    }
    // A second tick reads no new row: still one verdict.
    await f.controller.tickCommands();
    expect(await f.shape(byCli.id)).toHaveLength(1);
  });

  it("on a closed item it stores nothing and prints the controller's refusal, naming the PR when it had one", async () => {
    const f = await local();
    const closed = await f.filed({ stage: "CLOSED", close_reason: "rejected" });
    const unmerged = await f.filed({ stage: "CLOSED", close_reason: "rejected", change_ref: "42" });
    const before = await f.store.listCliCommandsAfter(0, 100);
    expect(await f.cli(closed.id, "accept")).toEqual({ code: 1, lines: ["`/verdict` was not applied: the work item is closed."] });
    expect(await f.cli(unmerged.id, "accept")).toEqual({ code: 1, lines: ["`/verdict` was not applied: the work item is closed and its PR was not merged."] });
    expect(await f.store.listCliCommandsAfter(0, 100)).toEqual(before);
  });

  it("a merged local item still takes one", async () => {
    const f = await local();
    const merged = await f.filed({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });
    expect((await f.cli(merged.id, "accept minor nit")).code).toBe(0);
    await f.controller.tickCommands();
    expect(await f.shape(merged.id)).toEqual([{ verdict: "accept", severity: "minor", reason: "nit", target: "issue", implicit: false, pr_head: null }]);
    expect(await f.store.getWorkItem(merged.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });
});
