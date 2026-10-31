import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, config, issueRef, mallory, prompts, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";

async function factory(runner: FakeRunner, knownSecrets: string[] = []) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const storage = new MemoryStorage();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage, clock, config, prompts, log: silent,
    scanner: new PatternEgressScanner(async () => knownSecrets),
    toolEnv: { PATH: "/usr/bin" },
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  return { clock, store, source, sandbox, broker, storage, controller, worker, step };
}

const review = (verdict: "pass" | "bug", tier = 2) => () => ({
  output: { verdict, tier, findings: verdict === "bug" ? ["off-by-one in gate"] : [], summary: "s" },
});

describe("one issue to one merged PR", () => {
  it("runs triage → human spec gate → implement → review loop → human merge, with a full trail", async () => {
    let reviews = 0;
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "added gate", next_steps: "none" } }),
      review: (s) => review(reviews++ === 0 ? "bug" : "pass")(),
    });
    const f = await factory(runner);
    const src = issueRef(7);

    f.source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "CI gate", body: "please" });
    await f.step();
    let item = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    expect(item).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 });
    expect(f.source.comments[0]!.body).toContain("Reply `/approve`");
    expect(f.source.comments[0]!.body).toContain(
      "**Allowed paths**: `.github/workflows/`\n**Files to change**: `.github/workflows/scope.yml`",
    );

    // An unauthorized approval is ignored.
    f.source.queue.push({ kind: "spec_approved", source: src, approver: mallory });
    await f.step();
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("READY");

    f.source.queue.push({ kind: "spec_approved", source: src, approver: alice });
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, loop_count: 1 });

    // Second implement run saw the reviewer's findings; reviewer prompt had no implementer transcript.
    const implementSpecs = runner.specs.filter((s) => s.role === "implement");
    expect(implementSpecs).toHaveLength(2);
    expect(implementSpecs[1]!.prompt).toContain("off-by-one in gate");
    expect(implementSpecs[0]!.writable_paths).toEqual(["/repo/.git"]);
    expect(f.broker.calls.filter((c) => c.name === "github.comment")).toHaveLength(2);
    expect(f.source.comments.at(-1)!.body).toContain("human merge is required");

    f.source.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${item.id}`, merge_sha: "m1", merger: alice });
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });

    const trail = (await f.store.listStateChanges(item.id)).map((c) => c.reason);
    expect(trail).toEqual([
      "intake", "triaged", "spec_approved", "implemented", "review_bug", "implemented", "review_passed", "pr_merged",
    ]);
    const approval = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: "github:1" });
    const merge = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "pr_merged")!;
    expect(merge.actor).toEqual({ kind: "user", id: "github:1" });
    expect(item.token_cost).toBe(15 * 5);
    expect(await f.store.listHandoffs(item.id)).toHaveLength(2);
    expect(f.sandbox.destroyed).toBe(f.sandbox.created.length);
  });

  it("duplicate intake events create one work item and one triage run", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }) }));
    const e = { kind: "item_requested" as const, source: issueRef(1), requester: alice, title: "t", body: "b" };
    f.source.queue.push(e, e);
    await f.controller.tickIntake();
    f.source.queue.push(e);
    await f.controller.tickIntake();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#1"))!;
    expect(await f.store.listRuns(item.id)).toHaveLength(1);
  });

  it("raises the tier to the floor and never lowers it at review", async () => {
    const runner = new FakeRunner({
      triage: () => ({
        output: { ...triageSpec, allowed_paths: ["src/impl/broker/"], files_to_change: ["src/impl/broker/"], tier: 1 },
      }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: review("pass", 1),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(2), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(2), approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#2"))!;
    expect(item.tier).toBe(4);
  });

  it("stops at max_loops and hands the item to a human", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: review("bug"),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(3), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(3), approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#3"))!;
    expect(item).toMatchObject({ blocked_on: "human", blocked_reason: "max_loops", loop_count: 2 });
    expect(runner.specs.filter((s) => s.role === "implement")).toHaveLength(3);
  });

  it("a failed run blocks on a human; /retry re-runs it with restart_count + 1", async () => {
    let fail = true;
    const runner = new FakeRunner({
      triage: () => (fail ? { status: "failed", error: "boom" } : { output: triageSpec }),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(4), requester: alice, title: "t", body: "b" });
    await f.step();
    let item = (await f.store.getWorkItemBySource("github_issue", "o/r#4"))!;
    expect(item).toMatchObject({ stage: "NEW", blocked_on: "human", blocked_reason: "run_failed:triage:agent_failed" });

    fail = false;
    f.source.queue.push({ kind: "retry_requested", source: issueRef(4), requester: alice });
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "READY", restart_count: 1, blocked_reason: "spec_pending" });
  });

  it("a triage output that lists a file outside allowed_paths fails the run and posts no spec", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: { ...triageSpec, files_to_change: [".github/workflows/scope.yml", "src/core/gate.ts"] } }),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#9"))!;
    expect(item).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:triage:invalid_output" });
    const runs = await f.store.listRuns(item.id);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["triage", "failed"]]);
    expect(f.source.comments.some((c) => c.body.includes("## Factory spec"))).toBe(false);
  });

  it("an implementer that makes no commits fails the run", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    });
    const f = await factory(runner);
    f.sandbox.commits = [];
    f.source.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(5), approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#5"))!;
    expect(item.blocked_reason).toBe("run_failed:implement:no_commits");
    expect(f.broker.calls.some((c) => c.name === "github.push_branch")).toBe(false);
  });

  it("a host sleep mid-implement does not lose the run: the worker renews, the reaper waits", async () => {
    let f!: Awaited<ReturnType<typeof factory>>;
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: async (spec) => {
        // The laptop sleeps: wall time jumps past lease_ms. Both loops tick after waking;
        // the controller's reaper happens to tick first.
        f.clock.advance(config.lease_ms + 30_000);
        const woke = f.clock.now().getTime();
        await f.controller.tickReaper();
        await waitFor(async () => {
          const run = (await f.store.getRun(spec.run_id))!;
          return run.status === "running" && new Date(run.lease!.expires_at).getTime() === woke + config.lease_ms;
        }, "worker renewal after wake");
        await f.controller.tickReaper();
        return { output: { summary: "added gate", next_steps: "none" } };
      },
      review: review("pass"),
    });
    f = await factory(runner);
    const src = issueRef(8);
    const step = async () => {
      await f.controller.tickReaper();
      await f.step();
      await f.controller.tickReaper();
    };

    f.source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    f.source.queue.push({ kind: "spec_approved", source: src, approver: alice });
    await step();

    const item = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 });
    const runs = await f.store.listRuns(item.id);
    expect(runs.map((r) => r.kind)).toEqual(["triage", "implement", "review"]);
    expect(runs.every((r) => r.attempt === 1 && r.status === "succeeded")).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("lease_expired");
    expect(f.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr", "github.comment"]);
  });

  it("spec rejection closes the item", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }) }));
    f.source.queue.push({ kind: "item_requested", source: issueRef(6), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_rejected", source: issueRef(6), approver: alice, reason: "no" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#6"))!;
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });
});
