// Check a page schedules (design 08-schedules, 08-routines): a routine is a schedule row with action `check_page`, and
// the schedule claim pass runs it with the routine planner (runDueCheckPages), routed by the `routed` ScheduleAction
// to the Check a page route, which queues the `routine` run. The fake runner stands in for AgentRunner and a
// FakeClock gives every time: no test here calls a model or a remote service. The routine run is finished by hand,
// as a worker would, and the controller applies it.

import { describe, expect, it } from "vitest";
import { checkPageAction } from "../src/controller/units/schedule/plugins/check-page/check-page-action.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { ROUTINE_CAP, type RoutineInput, addRoutine, carrierSource, holdSource } from "../src/core/routines.js";
import { SCHEDULE_CHECKPOINT, SCHEDULE_TOKEN_CAP, checkpointSourceId } from "../src/core/schedule.js";
import type { Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { RoutedScheduleAction } from "../src/impl/schedule-action/routed-action.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { READ_TOOLS } from "../src/worker/index.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";
import { newStore, w1 } from "./helpers/store.js";

const OWNER = "local:owner" as UserId;
const HOUR = 3_600_000;
const PROJECT = config.project.key;

const routine = (over: Partial<RoutineInput> = {}): RoutineInput => ({
  id: "rt_1", name: "Status page", instruction: "Check the status page lists every service.", url: "https://status.example.com/",
  schedule: { kind: "interval", spec: "60" }, zone: "UTC", trigger: null, run_cap_usd: null, daily_cap_usd: null, created_by: OWNER, ...over,
});

/**
 * A store with routine `over` (made at 08:59), the controller with the schedule unit's pass bound to the `routed`
 * action over the fake runner (no agent route is reached), and `merges`: the merge times the pass reads.
 */
async function harness(over: Partial<RoutineInput> = {}) {
  const clock = new FakeClock("2026-11-23T08:59:00.000Z");
  const { store } = await newStore(clock);
  const merges: Timestamp[] = [];
  const reads = Object.assign(Object.create(store) as SqlFactoryStore, { listMergeEvaluations: async () => merges.map((merged_at) => ({ merged_at })) as never });
  const runner = new FakeRunner({});
  const loaded = { config: { repo: { path: "/repo", base_branch: "main" }, deny_paths: [], run_timeout_ms: 60_000 } };
  const routes = { check_page: checkPageAction };
  const routed = new RoutedScheduleAction({ loaded, repo: { owner: "o", name: "r" }, extraScanValues: [], store, runner, sandbox: new FakeSandbox(), tools: READ_TOOLS, scanner: cleanScanner, project: PROJECT, routes } as never);
  const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, schedule_action: scheduledAction(reads, routed, silent, PROJECT) });
  const added = await addRoutine(store, routine(over), clock.now());
  if (!added.ok) throw new Error(added.problem);
  /** One schedule step at the FakeClock's time. */
  const tick = async () => (await controller.unit("schedule")).scheduleStep(tickAt("tick", 1, clock.now().getTime()));
  const runs = async () => {
    const carrier = await store.getWorkItemBySource("local", carrierSource("rt_1").id);
    return carrier ? (await store.listRuns(carrier.id)).filter((r) => r.kind === "routine") : [];
  };
  const queued = async () => (await runs()).filter((r) => r.status === "queued").map((r) => r.idempotency_key);
  /** The queued routine run, claimed and finished with `findings` at `cost_usd` (15 tokens); then the controller applies it. */
  const finish = async (findings: string[] = [], cost_usd = 0.1) => {
    const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null };
    const data = { routine: { verdict: findings.length > 0 ? "bug" : "pass", findings: findings.map((text) => ({ text })), summary: "s" }, usage, tokens: 15 };
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data });
    await controller.tickRuns();
    return run;
  };
  let n = 0;
  /** `/<name> <text>` on `id`, as the CLI stores it, then the controller's command poll. */
  const command = async (id: WorkItemId, name: string, text = "") => {
    await store.appendCliCommand({ key: `cli:check-page-${++n}`, actor: "local:1", command: name, args: { item: id, ...(text ? { text } : {}) } });
    await controller.tickCommands();
  };
  return { clock, store, merges, runner, tick, runs, queued, finish, command };
}

describe("a Check a page schedule", () => {
  it("is a schedule row the schedule list leaves out, with its instruction and page as the action's settings", async () => {
    const h = await harness();
    expect((await h.store.listSchedules()).map((s) => s.id)).not.toContain("rt_1");
    expect(await h.store.listCheckPages()).toEqual([
      expect.objectContaining({ id: "rt_1", title: "Status page", action: { kind: "check_page", settings: { instruction: routine().instruction, url: "https://status.example.com/" } } }),
    ]);
  });

  it("on On merge runs the routine run kind after a merge, once, and records its suggestions on the schedule", async () => {
    const h = await harness({ schedule: null, trigger: "merge" });
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.runs()).toEqual([]);
    const merged = "2026-11-23T09:30:00.000Z" as Timestamp;
    h.merges.push(merged);
    await h.tick();
    await h.tick();
    expect((await h.runs()).map((r) => [r.kind, r.idempotency_key, r.input])).toEqual([
      ["routine", `routine:rt_1:${merged}`, { routine: { instruction: routine().instruction, url: "https://status.example.com/" } }],
    ]);
    expect(await h.store.listScheduleRuns("rt_1")).toEqual([expect.objectContaining({ occurrence_at: merged, outcome: "fired" })]);
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ next_due_at: null, last_run_at: h.clock.now().toISOString() });
    expect(h.runner.specs).toEqual([]);

    const run = await h.finish(["The status page lists no database", "The status page lists no queue"]);
    expect((await h.store.listRoutineSuggestions("rt_1")).map((s) => [s.text, s.state, s.run_id])).toEqual([
      ["The status page lists no database", "pending", run.id],
      ["The status page lists no queue", "pending", run.id],
    ]);
    expect(await h.store.listScheduleRuns("rt_1")).toEqual([expect.objectContaining({ occurrence_at: merged, tokens: 15, cost_usd: 0.1 })]);
    // No merge since its last run: nothing more.
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.runs()).toHaveLength(1);
  });
});

describe("a Check a page schedule's USD caps", () => {
  it("a run over the per-run cap pauses the schedule, and a paused schedule fires no more", async () => {
    const h = await harness({ run_cap_usd: 0.5 });
    h.clock.advance(HOUR);
    await h.tick();
    await h.finish([], 0.75);
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ paused: true });
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.runs()).toHaveLength(1);
  });

  it("the daily cap holds a due run on a local item: /approve runs it, /reject skips it", async () => {
    const h = await harness({ daily_cap_usd: 1 });
    h.clock.advance(HOUR);
    await h.tick();
    await h.finish([], 0.6);
    // $0.60 spent today: another $0.60 run would pass $1, so the 10:59 slot is held.
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.queued()).toEqual([]);
    const held = (await h.store.getWorkItemBySource("local", holdSource("rt_1", "2026-11-23T10:59:00.000Z").id))!;
    expect(held).toMatchObject({ stage: "NEW", blocked_on: "human", blocked_reason: ROUTINE_CAP, requester_id: OWNER });
    await h.command(held.id, "approve");
    expect(await h.store.getWorkItem(held.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    await h.tick();
    expect(await h.queued()).toEqual(["routine:rt_1:2026-11-23T10:59:00.000Z"]);
    await h.finish([], 0.6);

    h.clock.advance(HOUR);
    await h.tick();
    const next = (await h.store.getWorkItemBySource("local", holdSource("rt_1", "2026-11-23T11:59:00.000Z").id))!;
    expect(next).toMatchObject({ blocked_on: "human", blocked_reason: ROUTINE_CAP });
    await h.command(next.id, "reject", "not today");
    expect(await h.store.getWorkItem(next.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    await h.tick();
    expect(await h.queued()).toEqual([]);
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ last_run_at: h.clock.now().toISOString(), next_due_at: "2026-11-23T12:59:00.000Z" });
  });
});

describe("a Check a page schedule's token cap", () => {
  it("an occurrence over its token cap is held at a checkpoint: no run is queued until /approve", async () => {
    const h = await harness();
    expect(await h.store.updateSchedule("rt_1", "2026-11-23T09:59:00.000Z" as Timestamp, { token_cap: 10 })).toBe(true);
    h.clock.advance(HOUR);
    await h.tick();
    await h.finish(); // 15 tokens: over the 10-token cap
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.queued()).toEqual([]);
    const slot = "2026-11-23T10:59:00.000Z";
    expect((await h.store.listScheduleRuns("rt_1")).map((r) => [r.occurrence_at, r.outcome])).toEqual([["2026-11-23T09:59:00.000Z", "fired"], [slot, "checkpoint"]]);
    const item = (await h.store.getWorkItemBySource("local", checkpointSourceId("rt_1", slot)))!;
    expect(item).toMatchObject({ blocked_on: "human", blocked_reason: SCHEDULE_CHECKPOINT });
    await h.command(item.id, "approve");
    await h.tick();
    expect(await h.queued()).toEqual([`routine:rt_1:${slot}`]);
    expect((await h.store.listCheckPages())[0]).toMatchObject({ token_cap: 15 + SCHEDULE_TOKEN_CAP, running_since: null });
  });
});
