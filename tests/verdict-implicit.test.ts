import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { Logger } from "../src/core/log.js";
import { Worker } from "../src/core/worker.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, recordingLog, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Implicit verdicts (issue #316, design §4): a merge, a person's push to a factory PR and a revert of a merged
// factory PR each record a verdict nobody typed, through the normal intake path. One verdict per PR head; an
// explicit `/verdict` replaces the head's implicit one.

const MERGE_SHA = "a1b2c3d4e5f6a7b8c9d0";

async function factory(log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 1, findings: [], summary: "fine" } }),
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock,
    config, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const poll = async (...events: SourceEvent[]) => {
    source.queue.push(...events);
    await controller.tickIntake();
  };
  const work = async () => {
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  /** A factory item through triage, approval, implement and review: REVIEW, waiting for a merge of PR 42. */
  const ready = async (n = 61): Promise<WorkItem> => {
    const src = issueRef(n);
    await poll({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await work();
    await poll({ kind: "spec_approved", source: src, comment_id: `approve-${n}`, approver: alice });
    await work();
    const it = (await store.getWorkItemBySource("github_issue", src.id))!;
    expect(it).toMatchObject({ origin: "factory", pr_number: 42, blocked_reason: "merge_pending", last_head_sha: "base" });
    return it;
  };
  const pr = (it: WorkItem) => ({ pr_number: 42, head_branch: `factory/${it.id}` });
  const merged = (it: WorkItem, merger: ExternalIdentity | null = alice): SourceEvent =>
    ({ kind: "pr_merged", ...pr(it), merge_sha: MERGE_SHA, merger });
  const pushed = (it: WorkItem, head_sha: string): SourceEvent => ({
    kind: "pr_open", source: { type: "github_issue", id: "o/r#42", link: "https://github.com/o/r/pull/42" }, ...pr(it), head_sha,
    title: "t", body: "b", author: alice, labels: [],
  });
  return { clock, store, source, controller, poll, work, ready, pr, merged, pushed };
}

describe("implicit verdict on a merge", () => {
  it("a factory PR with no commits by people: one implicit accept, severity none, as the merger, on the merged head", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll(f.merged(it));
    const closed = (await f.store.getWorkItem(it.id))!;
    expect(closed).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: MERGE_SHA });
    const verdicts = await f.store.listVerdicts(it.id);
    expect(verdicts).toEqual([
      expect.objectContaining({ verdict: "accept", severity: "none", reason: null, implicit: true, pr_head: "base", target: "pr" }),
    ]);
    // Linked to the merge's own row, whose actor is the merger; no row of its own.
    const sc = (await f.store.listStateChanges(it.id)).find((c) => c.id === verdicts[0]!.state_change_id)!;
    expect(sc).toMatchObject({ reason: "pr_merged", actor: { kind: "user", id: "github:1" } });
    expect((await f.store.listStateChanges(it.id)).at(-1)!.reason).toBe("pr_merged");
  });

  it("running the merge handler twice records exactly one verdict for that PR head", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll(f.merged(it));
    await f.poll(f.merged(it));
    await f.controller.handleEvent(f.merged(it));
    expect(await f.store.listVerdicts(it.id)).toEqual([expect.objectContaining({ verdict: "accept", pr_head: "base", implicit: true })]);
  });

  it("a merger that does not resolve to a user: no implicit verdict, and a log line says why", async () => {
    const log = recordingLog();
    const f = await factory(log);
    const it = await f.ready();
    await f.poll(f.merged(it, null));
    expect((await f.store.getWorkItem(it.id))!).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await f.store.listVerdicts(it.id)).toEqual([]);
    expect(log.lines).toContainEqual(expect.objectContaining({
      level: "warn", msg: expect.stringContaining("merger does not resolve to a user"), fields: expect.objectContaining({ work_item_id: it.id }),
    }));
  });

  it("a PR closed without a merge records no verdict", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll({ kind: "pr_closed", ...f.pr(it) });
    expect(await f.store.listVerdicts(it.id)).toEqual([]);
  });
});

describe("implicit verdict on a person's push", () => {
  it("one implicit changes (minor) on the pushed head, with the commit count in its reason; no stage or block changes", async () => {
    const f = await factory();
    const it = await f.ready();
    f.source.commitAuthors.h9 = alice;
    await f.poll(f.pushed(it, "h9"));
    await f.poll(f.pushed(it, "h9"));
    const after = (await f.store.getWorkItem(it.id))!;
    expect(after).toMatchObject({
      stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason, version: it.version, last_head_sha: "h9",
    });
    const verdicts = await f.store.listVerdicts(it.id);
    expect(verdicts).toEqual([expect.objectContaining({ verdict: "changes", severity: "minor", implicit: true, pr_head: "h9" })]);
    expect(verdicts[0]!.reason).toMatch(/^1 commit by a person/);
    // The key names the manual run, which holds the pusher.
    const manual = (await f.store.listRuns(it.id)).filter((r) => r.kind === "manual");
    expect(verdicts[0]!.comment_id).toBe(`implicit:push:${manual[0]!.id}`);
    expect(manual[0]!.outcome).toMatchObject({ data: { actor: { kind: "user", id: "github:1" } } });

    f.source.commitAuthors.h10 = alice;
    await f.poll(f.pushed(it, "h10"));
    expect((await f.store.listVerdicts(it.id)).map((v) => [v.pr_head, v.reason?.split(" by")[0]])).toEqual([["h9", "1 commit"], ["h10", "2 commits"]]);
  });

  it("a person's commit, then the merge: the head ends with changes and no accept", async () => {
    const f = await factory();
    const it = await f.ready();
    f.source.commitAuthors.h9 = alice;
    await f.poll(f.pushed(it, "h9"));
    await f.poll(f.merged(it));
    expect((await f.store.getWorkItem(it.id))!).toMatchObject({ stage: "CLOSED", last_head_sha: "h9" });
    const verdicts = await f.store.listVerdicts(it.id);
    expect(verdicts.map((v) => [v.verdict, v.pr_head, v.implicit])).toEqual([["changes", "h9", true]]);
    expect(verdicts.some((v) => v.verdict === "accept")).toBe(false);
  });

  it("implicit verdicts never change stage, blocked_on or blocked_reason (nor the version or the trail)", async () => {
    const f = await factory();
    const open = await f.ready();
    const trail = async () => (await f.store.listStateChanges(open.id)).map((c) => c.reason);
    const before = await trail();
    f.source.commitAuthors.h9 = alice;
    await f.poll(f.pushed(open, "h9"));
    expect((await f.store.listVerdicts(open.id)).map((v) => v.verdict)).toEqual(["changes"]);
    expect(await f.store.getWorkItem(open.id)).toMatchObject({
      stage: open.stage, blocked_on: open.blocked_on, blocked_reason: open.blocked_reason, version: open.version,
    });
    expect(await trail()).toEqual(before);

    const g = await factory();
    const it = await g.ready();
    await g.poll(g.merged(it));
    const closed = (await g.store.getWorkItem(it.id))!;
    await g.poll({ kind: "base_commit", sha: "r1", message: `Revert "t"\n\nThis reverts commit ${MERGE_SHA}.` });
    expect((await g.store.listVerdicts(it.id)).map((v) => v.verdict)).toEqual(["accept", "reverted"]);
    const after = (await g.store.getWorkItem(it.id))!;
    // The revert's own `reverted` state change bumps the version (revert tracking); the verdicts change nothing.
    expect(after).toMatchObject({ stage: closed.stage, blocked_on: closed.blocked_on, blocked_reason: closed.blocked_reason });
    expect((await g.store.listStateChanges(it.id)).map((c) => c.reason).slice(-2)).toEqual(["pr_merged", "reverted"]);
  });
});

describe("explicit /verdict against an implicit one", () => {
  const verdictOnPr = (f: Awaited<ReturnType<typeof factory>>, it: WorkItem, args: string, comment_id: string): SourceEvent => ({
    kind: "verdict_submitted", target: { kind: "pr", ...f.pr(it) }, comment_id, approver: alice, args,
  });

  it("an explicit /verdict on the merged head replaces its implicit verdict: one verdict remains for the head", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll(f.merged(it));
    await f.poll(verdictOnPr(f, it, "changes major missed a case", "900"));
    const verdicts = await f.store.listVerdicts(it.id);
    expect(verdicts.filter((v) => v.pr_head === "base")).toEqual([
      expect.objectContaining({ verdict: "changes", severity: "major", implicit: false, comment_id: "900" }),
    ]);
    expect(f.source.comments.filter((c) => c.marker.includes("refused"))).toEqual([]);
  });

  it("an explicit /verdict on an open PR's head replaces a person's-push verdict on it", async () => {
    const f = await factory();
    const it = await f.ready();
    f.source.commitAuthors.h9 = alice;
    await f.poll(f.pushed(it, "h9"));
    await f.poll(verdictOnPr(f, it, "yes", "901"));
    expect((await f.store.listVerdicts(it.id)).map((v) => [v.verdict, v.severity, v.pr_head, v.implicit])).toEqual([["accept", "none", "h9", false]]);
  });

  it("on a closed item with no implicit verdict on its head, /verdict is refused and stores nothing", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll(f.merged(it, null));
    await f.poll(verdictOnPr(f, it, "accept", "902"));
    expect(await f.store.listVerdicts(it.id)).toEqual([]);
    const replies = f.source.comments.filter((c) => c.marker === "<!-- factory:refused:902 -->");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain("the work item is closed");
  });
});

describe("implicit verdict on a revert", () => {
  it("a revert of a merged factory PR: one implicit reverted verdict per reverting commit, redeliveries add nothing", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll(f.merged(it));
    const revert = (sha: string): SourceEvent => ({ kind: "base_commit", sha, message: `Revert "t"\n\nThis reverts commit ${MERGE_SHA}.` });
    await f.poll(revert("r1"));
    await f.poll(revert("r1"));
    await f.poll(revert("r2"));
    const reverted = (await f.store.listVerdicts(it.id)).filter((v) => v.verdict === "reverted");
    expect(reverted.map((v) => [v.comment_id, v.implicit, v.pr_head])).toEqual([
      [`implicit:reverted:${it.id}:r1`, true, "base"],
      [`implicit:reverted:${it.id}:r2`, true, "base"],
    ]);
    expect(reverted[0]!.reason).toContain("r1");
    // The merge's accept on the same head stays: a revert is outside the one-verdict-per-head rule.
    expect((await f.store.listVerdicts(it.id)).filter((v) => v.verdict === "accept")).toHaveLength(1);
  });

  it("a revert naming an open (unmerged) item's PR records no verdict", async () => {
    const f = await factory();
    const it = await f.ready();
    await f.poll({ kind: "base_commit", sha: "r3", message: 'Revert "t (#42)"' });
    expect(await f.store.listVerdicts(it.id)).toEqual([]);
  });
});
