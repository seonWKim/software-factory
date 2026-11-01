import { describe, expect, it } from "vitest";
import type { Budgets } from "../src/core/budget.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { UserId, WorkItem, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { newStore, PROJECT_KEY } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config as baseConfig, gates, issueRef, mallory, prompts, recordingLog, settingsWith, triageSpec,
} from "./helpers/fakes.js";

// Design §6: per-tier token budgets. At the budget the next implement or review run is held at a checkpoint.

type Script = () => Partial<AgentRunResult>;
const used = (tokens: number, output: unknown): Partial<AgentRunResult> => ({
  output,
  usage: { input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null },
});
const pass = { verdict: "pass", tier: 2, findings: [], summary: "s" };
const bug = { verdict: "bug", tier: 2, findings: ["off by one"], summary: "s" };
const done = { summary: "s", next_steps: "n" };

async function factory(opts: {
  budgets?: Budgets;
  min_sample?: number;
  /** Human spec approval for tier 2 (default: auto-approved). */
  specGate?: boolean;
  triage?: Script;
  implement?: Script;
  review?: Script;
  config?: Partial<FactoryConfig>;
}) {
  const config: FactoryConfig = {
    ...baseConfig,
    dials: { spec_gate_min_tier: opts.specGate ? 1 : 3, auto_merge_max_tier: 0 },
    ...(opts.budgets ? { settings: settingsWith({ budgets: opts.budgets }) } : {}),
    ...(opts.min_sample ? { budget_min_sample: opts.min_sample } : {}),
    ...opts.config,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const broker = new FakeBroker();
  const runner = new FakeRunner({
    triage: opts.triage ?? (() => used(100, triageSpec)),
    implement: opts.implement ?? (() => used(100, done)),
    review: opts.review ?? (() => used(100, pass)),
  });
  const log = recordingLog();
  const controllerFor = (c: FactoryConfig) =>
    new Controller({ store, source, auth: new FakeAuth(), clock, config: c, log, scanner: cleanScanner });
  const controller = controllerFor(config);
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(),
    clock, config, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const src = issueRef(1);
  const step = async (c = controller) => {
    await c.tickIntake();
    while (await worker.tick()) await c.tickRuns();
    await c.tickRuns();
  };
  const submit = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  let commentId = 1000;
  const say = async (e: (comment_id: string) => SourceEvent, c = controller) => {
    source.queue.push(e(String(++commentId)));
    await c.tickIntake();
  };
  const budget = (amount: string | null, who = alice) =>
    say((comment_id) => ({ kind: "budget_continue", source: src, comment_id, approver: who, amount }));
  const reject = () => say((comment_id) => ({ kind: "spec_rejected", source: src, comment_id, approver: alice, reason: "too costly" }));
  const item = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const reasons = async (it: WorkItem) => (await store.listStateChanges(it.id)).map((c) => c.reason);
  const budgetComments = () => source.comments.filter((c) => c.marker.startsWith("<!-- factory:budget:"));
  const refusals = () => source.comments.filter((c) => c.marker.startsWith("<!-- factory:refused:"));
  return {
    config, clock, store, source, broker, runner, log, controller, controllerFor, worker, src,
    step, submit, say, budget, reject, item, reasons, budgetComments, refusals,
  };
}

describe("the checkpoint", () => {
  it("at or over the tier budget when the next run would start: blocked_on budget, no run queued, one comment, one state change", async () => {
    // Triage 100 + implement 900 = 1000: the review run would start exactly at the budget.
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const it1 = await f.item(it0);
    expect(it1).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 1000, blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    const runs = await f.store.listRuns(it0.id);
    expect(runs.map((r) => r.kind)).toEqual(["triage", "implement"]);
    expect(runs.every((r) => r.acknowledged_at !== null)).toBe(true);

    const rows = (await f.store.listStateChanges(it0.id)).filter((c) => c.reason === "budget_checkpoint");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes).toMatchObject({ stage: { from: "RUNNING", to: "REVIEW" }, blocked_on: { from: "none", to: "budget" } });
    expect(rows[0]!.detail).toMatchObject({ held_reason: "implemented", held_run_kind: "review", tokens_spent: 1000, budget: 1000 });

    const [cp, ...more] = await f.store.listBudgetCheckpoints(it0.id);
    expect(more).toEqual([]);
    expect(cp).toMatchObject({
      tier: 2, tokens_spent: 1000, budget: 1000, suggested_budget: 2000, answer: "pending", outcome: null,
      held_run_kind: "review", held_run_key: `${it0.id}:review:l0:r0`, held_run_not_before: null,
    });

    expect(f.budgetComments()).toHaveLength(1);
    const body = f.budgetComments()[0]!.body;
    for (const s of ["`REVIEW`", "PR #42", "2 runs", "1000 tokens", "Current budget: 1000", "Suggested budget: 2000", "base rule", "0 merged", "`/budget`", "`/budget <tokens>`", "`/reject <reason>`"]) {
      expect(body).toContain(s);
    }
    expect(f.source.statusLabels(f.src)).toEqual(["needs_human"]);
  });

  it("keeps the branch, the open PR, the handoffs and the run history as they were", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    f.source.queue.push({ kind: "item_requested", source: f.src, requester: alice, title: "t", body: "b" });
    await f.controller.tickIntake();
    let checked = false;
    while (await f.worker.tick()) {
      const [run] = await f.store.listUnacknowledgedRuns(1);
      if (run?.kind !== "implement") {
        await f.controller.tickRuns();
        continue;
      }
      // The implement run pushed and opened the PR. Snapshot, then let the controller hit the checkpoint.
      const it0 = (await f.store.getWorkItemBySource("github_issue", f.src.id))!;
      const handoffs = await f.store.listHandoffs(it0.id);
      const before = await f.store.listRuns(it0.id);
      const brokerCalls = f.broker.calls.length;
      await f.controller.tickRuns();
      expect((await f.item(it0)).blocked_reason).toBe("budget_checkpoint");
      expect(await f.store.listHandoffs(it0.id)).toEqual(handoffs);
      expect(handoffs.length).toBeGreaterThan(0);
      const after = await f.store.listRuns(it0.id);
      expect(after.map(({ acknowledged_at: _a, updated_at: _u, ...r }) => r)).toEqual(before.map(({ acknowledged_at: _a, updated_at: _u, ...r }) => r));
      // No push, no PR call: the branch and the PR are untouched.
      expect(f.broker.calls.length).toBe(brokerCalls);
      expect((await f.item(it0)).pr_number).toBe(42);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("a run in progress when the budget is reached finishes and its outcome is applied as usual", async () => {
    // The implement run alone spends far past the budget.
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(50_000, done) });
    const it0 = await f.submit();
    const runs = await f.store.listRuns(it0.id);
    expect(runs.find((r) => r.kind === "implement")).toMatchObject({ status: "succeeded" });
    expect(await f.reasons(it0)).toEqual(["intake", "triaged_auto_approved", "budget_checkpoint"]);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 50_100, blocked_on: "budget" });
  });

  it("triage runs are never held; their tokens count and the check happens when implement would start", async () => {
    const f = await factory({ budgets: { 2: 1000 }, triage: () => used(5000, triageSpec) });
    const it0 = await f.submit();
    expect((await f.store.listRuns(it0.id)).map((r) => r.kind)).toEqual(["triage"]);
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", token_cost: 5000, blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ held_run_kind: "implement" });
    expect(f.budgetComments()[0]!.body).toContain("no PR yet");
  });

  it("holds the implement run a spec approval would queue", async () => {
    const f = await factory({ budgets: { 2: 1000 }, specGate: true, triage: () => used(1500, triageSpec) });
    const it0 = await f.submit();
    expect(await f.item(it0)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    await f.say((comment_id) => ({ kind: "spec_approved", source: f.src, comment_id, approver: alice }));
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "budget" });
    expect((await f.store.listRuns(it0.id)).map((r) => r.kind)).toEqual(["triage"]);
    expect((await f.reasons(it0)).at(-1)).toBe("budget_checkpoint");
    expect((await f.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ held_reason: "spec_approved" });
  });

  it("holds the implement run of a review loop", async () => {
    const f = await factory({ budgets: { 2: 1000 }, review: () => used(800, bug) });
    const it0 = await f.submit();
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", loop_count: 1, token_cost: 1000, blocked_on: "budget" });
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({
      held_run_kind: "implement", held_run_key: `${it0.id}:implement:l1:r0`,
    });
  });

  it("a tier with no budget never gets a checkpoint", async () => {
    const f = await factory({ budgets: { 1: 10, 3: 10 }, implement: () => used(50_000, done) });
    const it0 = await f.submit();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    expect(await f.store.listBudgetCheckpoints(it0.id)).toEqual([]);
    expect(f.budgetComments()).toEqual([]);
  });

  it("no budgets in the config means no limits for any tier", async () => {
    const f = await factory({ implement: () => used(10_000_000, done) });
    expect(gates(f.config).budgets).toEqual({});
    const it0 = await f.submit();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(await f.store.listBudgetCheckpoints(it0.id)).toEqual([]);
  });

  it("applying the same finished run twice opens one checkpoint and posts one comment", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    f.source.queue.push({ kind: "item_requested", source: f.src, requester: alice, title: "t", body: "b" });
    await f.controller.tickIntake();
    await f.worker.tick();
    await f.controller.tickRuns();
    await f.worker.tick();
    const [run] = await f.store.listUnacknowledgedRuns(1);
    await Promise.all([f.controller.applyRun(run!), f.controller.applyRun(run!)]);
    await f.controller.applyRun(run!);
    const it0 = (await f.store.getWorkItemBySource("github_issue", f.src.id))!;
    expect(await f.store.listBudgetCheckpoints(it0.id)).toHaveLength(1);
    expect((await f.reasons(it0)).filter((r) => r === "budget_checkpoint")).toHaveLength(1);
    expect(f.budgetComments()).toHaveLength(1);
  });
});

describe("/budget", () => {
  it("with no number starts the held run once, with its kind and key, and clears the checkpoint", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const cp = (await f.store.listBudgetCheckpoints(it0.id))[0]!;
    await f.budget(null);
    expect(await f.item(it0)).toMatchObject({ blocked_on: "none", blocked_reason: null, stage: "REVIEW" });
    const queued = (await f.store.listRuns(it0.id)).filter((r) => r.status === "queued");
    expect(queued).toMatchObject([{ kind: "review", idempotency_key: cp.held_run_key, not_before: null }]);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "continued_suggested", granted_budget: 2000 });
    const row = (await f.store.listStateChanges(it0.id)).at(-1)!;
    expect(row).toMatchObject({ reason: "budget_continued", actor: { kind: "user", id: "github:1" } });
    expect(f.source.reactions.some((r) => r.comment_id === "1001")).toBe(true);
    expect(f.refusals()).toEqual([]);

    // The same branch: the review runs on the open PR, then waits for a human merge.
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 });
    expect((await f.store.listRuns(it0.id)).filter((r) => r.kind === "review")).toHaveLength(1);

    // A second /budget has no checkpoint to answer.
    await f.budget(null);
    expect(f.refusals().at(-1)!.body).toContain("`/budget` was not applied: the work item is not at a budget checkpoint");
  });

  it("`/budget 9000000` sets the new budget to 9000000 and starts the held run", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done), review: () => used(1000, bug) });
    const it0 = await f.submit();
    await f.budget("9000000");
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "continued_custom", granted_budget: 9_000_000 });
    expect((await f.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ granted_budget: 9_000_000, previous_budget: 1000 });
    // The review loop goes on under the new budget: no second checkpoint below 9000000 tokens.
    await f.step();
    const it1 = await f.item(it0);
    expect(it1.token_cost).toBeGreaterThan(2000);
    expect(it1.blocked_on).not.toBe("budget");
    expect(await f.store.listBudgetCheckpoints(it0.id)).toHaveLength(1);
  });

  it("a number that is not whole, or not greater than the current budget, is refused and changes nothing", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const before = await f.item(it0);
    for (const amount of ["1.5", "lots", "1000", "999"]) await f.budget(amount);
    expect(await f.item(it0)).toEqual(before);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "pending" });
    expect((await f.store.listRuns(it0.id)).filter((r) => r.status === "queued")).toEqual([]);
    const bodies = f.refusals().map((c) => c.body);
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toBe("`/budget` was not applied: `1.5` is not a whole number of tokens.");
    expect(bodies[2]).toBe("`/budget` was not applied: the new budget must be greater than the current budget (1000 tokens).");
  });

  it("from a user without write permission is refused and changes nothing", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const before = await f.item(it0);
    await f.budget(null, mallory);
    await f.budget("9000000", mallory);
    expect(await f.item(it0)).toEqual(before);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "pending" });
    expect(f.refusals().map((c) => c.body)).toEqual([
      "`/budget` was not applied: it needs write permission on this repository (`not_a_collaborator`).",
      "`/budget` was not applied: it needs write permission on this repository (`not_a_collaborator`).",
    ]);
  });

  it("an automatic retry due at a checkpoint is held, and /budget queues it with its not_before", async () => {
    let implementRuns = 0;
    // Triage 100 + implement 800 + review 200 = 1100: the loop's implement run is held. After a grant of 1001
    // (above the budget, below what is spent) it starts once and fails, so its retry is due past the budget.
    const f = await factory({
      budgets: { 2: 1000 },
      implement: () => (implementRuns++ === 0 ? used(800, done) : { status: "failed", error: "boom" }),
      review: () => used(200, bug),
    });
    const it0 = await f.submit();
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ held_run_kind: "implement", budget: 1000 });
    await f.budget("1001");
    await f.step();
    const it1 = await f.item(it0);
    expect(it1).toMatchObject({ blocked_on: "budget", blocked_reason: "budget_checkpoint", stage: "RUNNING" });
    const [, second] = await f.store.listBudgetCheckpoints(it0.id);
    const failed = (await f.store.listRuns(it0.id)).at(-1)!;
    expect(failed).toMatchObject({ kind: "implement", status: "failed" });
    const notBefore = new Date(Date.parse(failed.finished_at!) + f.config.retry_base_ms).toISOString();
    expect(second).toMatchObject({
      budget: 1001, held_run_kind: "implement", held_run_key: `${failed.idempotency_key}:a1`, held_run_not_before: notBefore,
    });
    expect((await f.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ held_reason: "run_retry_scheduled" });

    await f.budget(null);
    expect((await f.store.listRuns(it0.id)).at(-1)).toMatchObject({
      status: "queued", idempotency_key: `${failed.idempotency_key}:a1`, not_before: notBefore,
    });
  });

  it("/retry on an item past its budget gets a checkpoint, not a run", async () => {
    // Blocked at max_attempts with no budget configured; then a controller with a budget takes the /retry.
    const f = await factory({ implement: () => ({ status: "failed", error: "boom" }), triage: () => used(5000, triageSpec) });
    const it0 = await f.submit();
    for (let i = 0; i < 3; i++) {
      f.clock.advance(f.config.retry_max_ms);
      await f.step();
    }
    expect(await f.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
    const runs = (await f.store.listRuns(it0.id)).length;
    const withBudget = f.controllerFor({ ...f.config, settings: settingsWith({ budgets: { 2: 1000 } }, f.config) });
    await f.say((comment_id) => ({ kind: "retry_requested", source: f.src, comment_id, requester: alice }), withBudget);
    expect(await f.item(it0)).toMatchObject({ blocked_on: "budget", blocked_reason: "budget_checkpoint", restart_count: 1 });
    expect(await f.store.listRuns(it0.id)).toHaveLength(runs);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ held_run_key: `${it0.id}:implement:l0:r1` });
  });

  it("/approve, /retry and /revise at a checkpoint are refused with how to answer", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const before = await f.item(it0);
    await f.say((comment_id) => ({ kind: "spec_approved", source: f.src, comment_id, approver: alice }));
    await f.say((comment_id) => ({ kind: "retry_requested", source: f.src, comment_id, requester: alice }));
    await f.say((comment_id) => ({ kind: "revise_requested", source: f.src, comment_id, requester: alice, feedback: "smaller" }));
    expect(await f.item(it0)).toEqual(before);
    expect(f.refusals()).toHaveLength(3);
    for (const c of f.refusals()) expect(c.body).toContain("at a budget checkpoint");
  });
});

describe("/reject at a checkpoint", () => {
  it("closes the item as rejected, leaves the branch and the PR, and records the answer and outcome", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    const brokerCalls = f.broker.calls.length;
    await f.reject();
    expect(await f.item(it0)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", blocked_on: "none", pr_number: 42 });
    expect(f.broker.calls.length).toBe(brokerCalls);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "rejected", granted_budget: null, outcome: "rejected" });
    const rows = (await f.store.listStateChanges(it0.id)).filter((c) => c.reason.startsWith("budget_"));
    expect(rows.map((c) => c.reason)).toEqual(["budget_checkpoint", "budget_rejected"]);
    expect(rows[1]!.actor).toEqual({ kind: "user", id: "github:1" as UserId });
    expect(f.source.statusLabels(f.src)).toEqual(["rejected"]);
  });
});

describe("outcome and history", () => {
  it("a continued item that merges sets the checkpoint outcome to merged", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    await f.budget(null);
    await f.step();
    f.source.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${it0.id}`, merge_sha: "m1", merger: alice });
    await f.controller.tickIntake();
    expect(await f.item(it0)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ answer: "continued_suggested", outcome: "merged" });
  });

  it("with budget_min_sample finished items in the tier, the suggestion is p90 of merged token_cost rounded up to 100000", async () => {
    const f = await factory({ budgets: { 2: 1000 }, min_sample: 3, implement: () => used(900, done) });
    const sys = { kind: "system" as const, id: "system:test" };
    // Three finished tier-2 items: two merged (250000, 1234567), one rejected (ignored by the percentile).
    for (const [n, close_reason, token_cost] of [[101, "completed", 250_000], [102, "completed", 1_234_567], [103, "rejected", 9_000_000]] as const) {
      const { item } = await f.store.createWorkItem(
        { source: issueRef(n), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, sys,
      );
      await f.store.transition({ id: item.id, expected_version: 1, actor: sys, reason: "x", patch: { tier: 2, token_cost, stage: "CLOSED", close_reason } });
    }
    const it0 = await f.submit();
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ suggested_budget: 1_300_000 });
    const body = f.budgetComments()[0]!.body;
    expect(body).toContain("Suggested budget: 1300000 tokens");
    expect(body).toMatch(/90th percentile/);
    expect(body).toMatch(/2 merged tier-2 items/);
  });

  it("before budget_min_sample finished items, the suggestion is the current budget plus the tier budget", async () => {
    const f = await factory({ budgets: { 2: 1000 }, implement: () => used(900, done) });
    const it0 = await f.submit();
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ budget: 1000, suggested_budget: 2000 });
    expect(f.budgetComments()[0]!.body).toContain("fewer than budget_min_sample (10)");
  });

  it("a history suggestion not above the current budget is replaced by the base rule, and the comment says so", async () => {
    const f = await factory({ budgets: { 2: 1000 }, min_sample: 1, implement: () => used(900, done) });
    const sys = { kind: "system" as const, id: "system:test" };
    const { item } = await f.store.createWorkItem(
      { source: issueRef(201), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, sys,
    );
    // One merged item at 1 token: p90 rounded up is 100000, above the first budget (1000), so it stands.
    await f.store.transition({ id: item.id, expected_version: 1, actor: sys, reason: "x", patch: { tier: 2, token_cost: 1, stage: "CLOSED", close_reason: "completed" } });
    const it0 = await f.submit();
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ budget: 1000, suggested_budget: 100_000 });
    // Continue at 200000, spend past it in the review; at the loop's implement, history (100000) is not above it.
    await f.budget("200000");
    f.runner.script.review = () => used(250_000, bug);
    await f.step();
    const second = (await f.store.listBudgetCheckpoints(it0.id))[1]!;
    expect(second).toMatchObject({ budget: 200_000, suggested_budget: 201_000 });
    const body = f.budgetComments().at(-1)!.body;
    expect(body).toMatch(/base rule/);
    expect(body).toContain("was not above the current budget (200000 tokens), so the base rule replaced it");
  });
});
