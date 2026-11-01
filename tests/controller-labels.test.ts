import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { Logger } from "../src/core/log.js";
import type { WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth, FakeSource, alice, config, issueRef, labelTarget, recordingLog, silent, triageSpec, waitFor } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

async function setup(log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log });
  return { clock, store, source, controller };
}

type F = Awaited<ReturnType<typeof setup>>;

/** Intake of issue #n through the controller, as a poll would deliver it. */
async function intake(f: F, n = 7): Promise<WorkItem> {
  f.source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
  await f.controller.tickIntake();
  return (await f.store.getWorkItemBySource("github_issue", issueRef(n).id))!;
}

/** Finishes the oldest queued run of `kind` with `data`, then lets the controller apply it. */
async function finish(f: F, kind: "triage" | "implement" | "review", data: Record<string, unknown>): Promise<void> {
  const run = await f.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
  expect(run?.kind).toBe(kind);
  await f.store.completeRun(run!.id, run!.lease!.token, { status: "succeeded", summary: "s", data });
  await f.controller.tickRuns();
}

describe("controller: status labels", () => {
  it("labels a new item triaging at intake, once", async () => {
    const f = await setup();
    const item = await intake(f);
    expect(f.source.statusLabels(item.source)).toEqual(["triaging"]);
    expect(f.source.statusCalls).toEqual([{ source: issueRef(7), status: "triaging", pr_number: null }]);

    // Re-delivery of the same issue creates nothing, so it writes no label.
    await intake(f);
    expect(f.source.statusCalls).toHaveLength(1);
  });

  it("moves triaging → needs approval → implementing, one status label at a time, other labels untouched", async () => {
    const f = await setup();
    const item = await intake(f);
    f.source.labels.get(labelTarget(item.source, null))!.add("bug");

    await finish(f, "triage", { spec: triageSpec });
    expect(f.source.statusLabels(item.source)).toEqual(["needs_approval"]);

    f.source.queue.push({ kind: "spec_approved", source: item.source, comment_id: "100", approver: alice });
    await f.controller.tickIntake();
    expect(f.source.statusLabels(item.source)).toEqual(["implementing"]);
    expect([...f.source.labels.get(labelTarget(item.source, null))!].sort()).toEqual(["bug", "implementing"]);
  });

  it("labels the PR with the same status once pr_number is set", async () => {
    const f = await setup();
    const item = await intake(f);
    await finish(f, "triage", { spec: triageSpec });
    f.source.queue.push({ kind: "spec_approved", source: item.source, comment_id: "100", approver: alice });
    await f.controller.tickIntake();
    expect(f.source.statusCalls.some((c) => c.pr_number !== null)).toBe(false);

    await finish(f, "implement", { pr_number: 42 });
    expect(f.source.statusLabels(item.source)).toEqual(["in_review"]);
    expect(f.source.statusLabels(item.source, 42)).toEqual(["in_review"]);

    await finish(f, "review", { review: { verdict: "pass", tier: 2, findings: [], summary: "ok" } });
    expect(f.source.statusLabels(item.source)).toEqual(["ready_to_merge"]);
    expect(f.source.statusLabels(item.source, 42)).toEqual(["ready_to_merge"]);

    f.source.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${item.id}`, merge_sha: "m1", merger: alice });
    await f.controller.tickIntake();
    expect(f.source.statusLabels(item.source)).toEqual(["done"]);
    expect(f.source.statusLabels(item.source, 42)).toEqual(["done"]);
  });

  it("does not write a label for an ack-only transition", async () => {
    const f = await setup();
    const item = await intake(f);
    const before = f.source.statusCalls.length;
    // A revert of a factory merge writes a `reverted` row with an empty patch.
    await f.store.transition({
      id: item.id, expected_version: item.version, patch: { pr_number: 9, merge_sha: "abc1234" }, actor: system, reason: "test",
    });
    f.source.queue.push({ kind: "base_commit", sha: "r1", message: "Revert x\n\nThis reverts commit abc1234." });
    await f.controller.tickIntake();
    const after = (await f.store.getWorkItem(item.id))!;
    expect(after.version).toBe(item.version + 2);
    expect(f.source.statusCalls.length).toBe(before);
  });

  it("commits the transition even when setStatus throws, and logs a warning", async () => {
    const log = recordingLog();
    const f = await setup(log);
    const item = await intake(f);
    f.source.statusError = new Error("GitHub down");

    await finish(f, "triage", { spec: triageSpec });
    const after = (await f.store.getWorkItem(item.id))!;
    expect(after.version).toBeGreaterThan(item.version);
    expect(after).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(f.source.statusCalls.at(-1)).toMatchObject({ status: "needs_approval" });
    expect(log.lines.some((l) => l.level === "warn" && l.msg === "set status failed")).toBe(true);
    expect(log.lines.some((l) => l.level === "error")).toBe(false);
  });

  it("a failing setStatus at intake still creates the item and enqueues triage", async () => {
    const f = await setup();
    f.source.statusError = new Error("GitHub down");
    const item = await intake(f);
    expect(item).toMatchObject({ stage: "NEW" });
    expect((await f.store.listRuns(item.id)).map((r) => r.kind)).toEqual(["triage"]);
  });
});

describe("controller: start-up status catch-up", () => {
  it("labels every open item that exists before start, skips closed ones, and keeps going past failures", async () => {
    const f = await setup();
    const a = (await f.store.createWorkItem(issue(1), system)).item;
    const b = (await f.store.createWorkItem(issue(2), system)).item;
    await f.store.transition({
      id: b.id, expected_version: b.version, actor: system, reason: "test",
      patch: { stage: "REVIEW", pr_number: 5, blocked_on: "human", blocked_reason: "merge_pending" },
    });
    const c = (await f.store.createWorkItem(issue(3), system)).item;
    await f.store.transition({
      id: c.id, expected_version: c.version, actor: system, reason: "test", patch: { stage: "CLOSED", close_reason: "completed" },
    });
    // The first call fails; the rest still run.
    const real = f.source.setStatus.bind(f.source);
    let calls = 0;
    f.source.setStatus = async (...args) => {
      if (calls++ === 0) throw new Error("boom");
      return real(...args);
    };

    const ac = new AbortController();
    const running = f.controller.run(ac.signal);
    await waitFor(() => calls >= 3, "catch-up");
    ac.abort();
    await running;

    const labelled = [a, b].map((it) => f.source.statusLabels(it.source)).concat([f.source.statusLabels(b.source, 5)]);
    // Newest first: b (issue, then PR), then a. The first call (b's issue) threw before reaching the fake.
    expect(f.source.statusCalls.slice(0, 2)).toEqual([
      { source: issueRef(2), status: "ready_to_merge", pr_number: 5 },
      { source: issueRef(1), status: "triaging", pr_number: null },
    ]);
    expect(labelled).toEqual([["triaging"], [], ["ready_to_merge"]]);
    expect(f.source.statusCalls.some((x) => x.source.id === issueRef(3).id)).toBe(false);
  });

  it("warns when the listing hits its limit", async () => {
    const log = recordingLog();
    const f = await setup(log);
    await f.store.createWorkItem(issue(1), system);
    const list = f.store.listWorkItems.bind(f.store);
    f.store.listWorkItems = async (limit) => {
      const items = await list(limit);
      return Array.from({ length: limit }, () => items[0]!);
    };
    const ac = new AbortController();
    const running = f.controller.run(ac.signal);
    await waitFor(() => log.lines.some((l) => l.msg === "status catch-up hit its limit"), "warning");
    ac.abort();
    await running;
    expect(log.lines.find((l) => l.msg === "status catch-up hit its limit")!.level).toBe("warn");
  });
});
