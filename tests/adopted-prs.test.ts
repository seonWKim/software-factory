import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { Logger } from "../src/core/log.js";
import { SKIP_LABEL } from "../src/core/policy.js";
import type { SourceRef, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, mallory, prompts, recordingLog, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Pull requests the factory did not open (design 2026-11-01): adoption, `factory: skip`, a person's pushes
// recorded as `manual` runs, and merges with no item recorded as unreviewed merges.

const bob: ExternalIdentity = { provider: "github", subject: "2", login: "bob" };

function prRef(n: number): SourceRef {
  return { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` };
}

function prOpen(n: number, o: Partial<Extract<SourceEvent, { kind: "pr_open" }>> = {}): SourceEvent {
  return {
    kind: "pr_open",
    source: prRef(n),
    pr_number: n,
    head_branch: "feature/x",
    head_sha: "h1",
    title: "Speed up the poll",
    body: "It reads fewer pages now.",
    author: bob,
    labels: [],
    ...o,
  };
}

async function factory(script: ConstructorParameters<typeof FakeRunner>[0] = {}, log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 1, findings: [], summary: "fine" } }),
    ...script,
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const poll = async (...events: SourceEvent[]) => {
    source.queue.push(...events);
    await controller.tickIntake();
  };
  const work = async () => {
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const item = async (n: number) => store.getWorkItemBySource("github_issue", `o/r#${n}`);
  return { clock, store, source, sandbox, broker, runner, controller, worker, poll, work, item };
}

describe("adopting a pull request a person opened", () => {
  it("one non-draft PR on a non-factory branch becomes one item at REVIEW with one review run; a second poll adds nothing", async () => {
    const f = await factory();
    f.source.prFileMap[50] = ["src/core/stats.ts", "docs/design.md"];
    await f.poll(prOpen(50));
    await f.poll(prOpen(50));

    expect(await f.store.listWorkItems(10)).toHaveLength(1);
    const it = (await f.item(50))!;
    expect(it).toMatchObject({
      origin: "adopted",
      source: prRef(50),
      title: "Speed up the poll",
      requester_id: "github:2",
      stage: "REVIEW",
      blocked_on: "none",
      pr_number: 50,
      head_branch: "feature/x",
      last_head_sha: "h1",
      allowed_paths: ["src/core/stats.ts", "docs/design.md"],
      done_criteria: null,
    });
    expect(it.problem).toContain("Speed up the poll");
    expect(it.problem).toContain("It reads fewer pages now.");
    const runs = await f.store.listRuns(it.id);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["review", "queued"]]);
    // Full details are read only for a PR the store does not know yet.
    expect(f.source.fileCalls).toEqual([50]);
    const sc = await f.store.listStateChanges(it.id);
    expect(sc.map((c) => [c.reason, c.actor])).toEqual([["pr_adopted", { kind: "user", id: "github:2" }]]);
    // The status label goes on the pull request (its source).
    expect(f.source.statusLabels(prRef(50))).toEqual(["in_review"]);
  });

  it("the review reads the PR's head branch, its title, body and diff with no spec, and comments on the PR", async () => {
    const f = await factory();
    f.source.prFileMap[50] = ["src/core/stats.ts"];
    await f.poll(prOpen(50));
    await f.work();

    expect(f.sandbox.created.map((s) => s.branch)).toEqual(["feature/x"]);
    const spec = f.runner.specs.find((s: AgentRunSpec) => s.role === "review")!;
    expect(spec.prompt).toContain("Speed up the poll");
    expect(spec.prompt).toContain("It reads fewer pages now.");
    expect(spec.prompt).toContain("+ a change");
    expect(spec.prompt).toContain("no spec");
    expect(spec.prompt).toContain("src/core/stats.ts");
    const posted = f.broker.calls.filter((c) => c.name === "github.comment");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.args).toMatchObject({ number: 50 });

    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 1 });
    const merge = f.source.comments.find((c) => c.body.includes("human merge is required"))!;
    expect(merge.source).toEqual(prRef(50));
    expect(f.source.statusLabels(prRef(50))).toEqual(["ready_to_merge"]);
  });

  it("a floor path among the PR's files raises the tier", async () => {
    const f = await factory();
    f.source.prFileMap[50] = ["src/impl/broker/github-broker.ts"];
    await f.poll(prOpen(50));
    expect((await f.item(50))!.tier).toBe(4);
    await f.work();
    expect((await f.item(50))!).toMatchObject({ tier: 4, blocked_reason: "merge_pending" });
  });

  it("a review that finds bugs blocks on a human: no implement run on a person's branch", async () => {
    const f = await factory({ review: () => ({ output: { verdict: "bug", tier: 1, findings: ["x"], summary: "bad" } }) });
    await f.poll(prOpen(50));
    await f.work();
    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "changes_requested", loop_count: 0 });
    expect((await f.store.listRuns(it.id)).map((r) => r.kind)).toEqual(["review"]);
  });

  it("a PR whose author the source does not name is not adopted", async () => {
    const f = await factory();
    await f.poll(prOpen(50, { author: null }));
    expect(await f.store.listWorkItems(10)).toEqual([]);
  });
});

describe("factory: skip", () => {
  it("added by a user with write permission: no item, and its merge writes one unreviewed merge", async () => {
    const f = await factory();
    f.source.labelAdders[`51:${SKIP_LABEL}`] = alice;
    await f.poll(prOpen(51, { labels: [SKIP_LABEL] }));
    await f.poll(prOpen(51, { labels: [SKIP_LABEL] }));
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(f.source.fileCalls).toEqual([]);

    const merged: SourceEvent = { kind: "pr_merged", pr_number: 51, head_branch: "feature/x", merge_sha: "m51", merger: alice };
    await f.poll(merged);
    await f.poll(merged);
    expect(await f.store.listWorkItems(10)).toEqual([]);
    const rows = await f.store.listUnreviewedMerges(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: "o/r", pr_number: 51, merge_sha: "m51", merger_id: "github:1" });
  });

  it("added by a user without write permission is ignored, and the PR is adopted", async () => {
    const f = await factory();
    f.source.labelAdders[`52:${SKIP_LABEL}`] = mallory;
    await f.poll(prOpen(52, { labels: [SKIP_LABEL] }));
    expect((await f.item(52))!).toMatchObject({ origin: "adopted", stage: "REVIEW" });
  });

  it("a label added after adoption does nothing", async () => {
    const f = await factory();
    await f.poll(prOpen(53));
    f.source.labelAdders[`53:${SKIP_LABEL}`] = alice;
    await f.poll(prOpen(53, { labels: [SKIP_LABEL] }));
    const it = (await f.item(53))!;
    expect(it).toMatchObject({ stage: "REVIEW", version: 1 });
  });
});

describe("a person's push to a factory or adopted PR", () => {
  it("gives one acknowledged manual run with the pusher and the range; no stage or blocked field changes", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    const before = (await f.item(50))!;
    f.source.commitAuthors.h2 = alice;
    await f.poll(prOpen(50, { head_sha: "h2" }));
    await f.poll(prOpen(50, { head_sha: "h2" }));

    const after = (await f.item(50))!;
    expect(after).toMatchObject({
      stage: before.stage, blocked_on: before.blocked_on, blocked_reason: before.blocked_reason, version: before.version,
      last_head_sha: "h2",
    });
    const manual = (await f.store.listRuns(after.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]!.status).toBe("succeeded");
    expect(manual[0]!.acknowledged_at).not.toBeNull();
    expect(manual[0]!.outcome).toMatchObject({
      status: "succeeded",
      data: { actor: { kind: "user", id: "github:1" }, from_sha: "h1", to_sha: "h2", pr_number: 50 },
    });
    // Never claimed, whatever kinds a worker asks for.
    await f.work();
    expect(await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["manual", "review"], lease_ms: 60_000 })).toBeNull();
    expect((await f.store.getRun(manual[0]!.id))!).toMatchObject({ status: "succeeded", attempt: 0, lease: null });
  });

  it("a pusher that does not resolve is recorded as system:pr-sync, with a warning", async () => {
    const log = recordingLog();
    const f = await factory({}, log);
    await f.poll(prOpen(50));
    await f.poll(prOpen(50, { head_sha: "h2" }));
    const manual = (await f.store.listRuns((await f.item(50))!.id)).filter((r) => r.kind === "manual");
    expect(manual[0]!.outcome).toMatchObject({ data: { actor: { kind: "system", id: "system:pr-sync" } } });
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("pusher"))).toBe(true);
  });

  it("on a factory PR: the factory's own push gives none; a person's push after it gives one", async () => {
    const f = await factory();
    const src = issueRef(61);
    await f.poll({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await f.work();
    await f.poll({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await f.work();
    const it = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    // The implement run recorded the head it pushed (FakeSandbox's HEAD).
    expect(it).toMatchObject({ origin: "factory", pr_number: 42, last_head_sha: "base", blocked_reason: "merge_pending" });

    const open = (sha: string) => prOpen(42, { head_branch: `factory/${it.id}`, head_sha: sha, source: prRef(42), author: alice });
    await f.poll(open("base"));
    expect((await f.store.listRuns(it.id)).filter((r) => r.kind === "manual")).toEqual([]);

    f.source.commitAuthors.h9 = alice;
    await f.poll(open("h9"));
    const manual = (await f.store.listRuns(it.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]!.outcome).toMatchObject({ data: { actor: { kind: "user", id: "github:1" }, from_sha: "base", to_sha: "h9" } });
    expect((await f.store.getWorkItem(it.id))!).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", version: it.version });
    // The factory PR is not adopted a second time.
    expect(await f.store.listWorkItems(10)).toHaveLength(1);
  });

  it("is not looked at while a run of the item is running (the factory may be pushing)", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    const run = await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["review"], lease_ms: 60_000 });
    expect(run).not.toBeNull();
    await f.poll(prOpen(50, { head_sha: "h2" }));
    const it = (await f.item(50))!;
    expect(it.last_head_sha).toBe("h1");
    expect((await f.store.listRuns(it.id)).filter((r) => r.kind === "manual")).toEqual([]);
  });
});

describe("merges of pull requests the factory did not open", () => {
  it("an adopted PR's merge closes its item as CLOSED / completed with the merger as approver of record", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    await f.work();
    await f.poll({ kind: "pr_merged", pr_number: 50, head_branch: "feature/x", merge_sha: "m50", merger: alice });
    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m50" });
    const last = (await f.store.listStateChanges(it.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "pr_merged", actor: { kind: "user", id: "github:1" } });
    expect(await f.store.listUnreviewedMerges(10)).toEqual([]);
    expect(f.source.statusLabels(prRef(50))).toEqual(["done"]);
  });

  it("an adopted PR closed without a merge closes its item as rejected", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    await f.poll({ kind: "pr_closed", pr_number: 50, head_branch: "feature/x" });
    expect((await f.item(50))!).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });

  it("a merged PR that was never adopted (a fork, or merged before any poll) writes one unreviewed merge and no item", async () => {
    const f = await factory();
    await f.poll(
      { kind: "pr_merged", pr_number: 60, head_branch: "feature/x", merge_sha: "m60", merger: alice, fork: true },
      { kind: "pr_merged", pr_number: 61, head_branch: "patch-1", merge_sha: "m61", merger: null },
    );
    await f.poll({ kind: "pr_merged", pr_number: 61, head_branch: "patch-1", merge_sha: "m61", merger: null });
    expect(await f.store.listWorkItems(10)).toEqual([]);
    const rows = await f.store.listUnreviewedMerges(10);
    expect(rows.map((r) => [r.pr_number, r.merge_sha, r.merger_id]).sort()).toEqual([[60, "m60", "github:1"], [61, "m61", null]]);
  });

  it("a PR closed without a merge and with no item records nothing", async () => {
    const f = await factory();
    await f.poll({ kind: "pr_closed", pr_number: 62, head_branch: "feature/x", fork: true });
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(await f.store.listUnreviewedMerges(10)).toEqual([]);
  });
});
