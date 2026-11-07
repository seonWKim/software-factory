import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import {
  DAY_MS, dailyImproveKey, dailyWindow, enqueueDailyImprove, enqueueManualImprove, groupFailures, normalizeDetail, runImprove, systemSource, utcDay,
} from "../src/core/improver.js";
import type { Run, Timestamp, UserId, WorkItemId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import {
  FakeAuth, FakeBroker, FakeSandbox, FakeSource, MemoryStorage, cleanScanner, config, prompts, silent,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

/** A model stub that fails the test if anything calls it. */
function forbiddenRunner(): AgentRunner & { calls: number } {
  const r = {
    calls: 0,
    async run(): Promise<never> {
      r.calls++;
      throw new Error("the improve run must not call a model");
    },
  };
  return r;
}

function setup(start: string) {
  const clock = new FakeClock(start);
  return newStore(clock).then(({ store }) => {
    const runner = forbiddenRunner();
    const sandbox = new FakeSandbox();
    const controller = new Controller({
      store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config, prompts,
      log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    return { clock, store, runner, sandbox, controller, worker };
  });
}

/** Item `n` with one triage run that failed with this code and detail, finished at the clock's now. */
async function failedRun(store: FactoryStore, n: number, error_code: string, detail: string): Promise<Run> {
  const { item } = await store.createWorkItem(
    {
      source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` },
      requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: `p${n}`, resources: [],
    },
    { kind: "system", id: "system:test" },
    { enqueue: { kind: "triage", idempotency_key: `seed:${n}` } },
  );
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  expect(run.work_item_id).toBe(item.id);
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code, detail, infra: false });
  return (await store.getRun(run.id))!;
}

const improveRuns = async (store: FactoryStore) => store.listRunsByKind("improve", ["queued", "running", "succeeded", "failed", "cancelled"]);

describe("scheduling", () => {
  it("the daily tick queues one improve run for the UTC day; a second tick that day queues none", async () => {
    const { store, controller, clock } = await setup("2026-03-10T08:00:00.000Z");
    await controller.tickImprove();
    clock.advance(3 * 3_600_000);
    await controller.tickImprove();
    const runs = await improveRuns(store);
    expect(runs.map((r) => r.idempotency_key)).toEqual([dailyImproveKey(PROJECT_KEY, "2026-03-10")]);
    expect(runs[0]!.input?.improve).toEqual({ start: "2026-03-09T00:00:00.000Z", end: "2026-03-10T00:00:00.000Z" });
    // It belongs to the project's one system item.
    const item = (await store.getWorkItem(runs[0]!.work_item_id))!;
    expect(item.source).toEqual(systemSource(PROJECT_KEY));
    expect(item.project).toBe(PROJECT_KEY);
  });

  it("the next UTC day gets its own run on the same system item", async () => {
    const { store, controller, clock } = await setup("2026-03-10T23:30:00.000Z");
    await controller.tickImprove();
    clock.advance(3_600_000);
    await controller.tickImprove();
    const runs = await improveRuns(store);
    const keys = runs.map((r) => r.idempotency_key);
    expect(keys).toContain(dailyImproveKey(PROJECT_KEY, "2026-03-10"));
    expect(keys).toContain(dailyImproveKey(PROJECT_KEY, "2026-03-11"));
    expect(new Set(runs.map((r) => r.work_item_id)).size).toBe(1);
  });

  it("factory improve queues exactly one run, with a key apart from the day's slot", async () => {
    const { store, controller, clock } = await setup("2026-03-10T08:00:00.000Z");
    await controller.tickImprove();
    const manual = await enqueueManualImprove(store, clock, PROJECT_KEY, "n-1");
    expect(manual.created).toBe(true);
    expect(manual.run.idempotency_key).not.toBe(dailyImproveKey(PROJECT_KEY, utcDay(clock.now())));
    // The same request again (same nonce) adds nothing; the day's slot is still free for nothing else.
    expect((await enqueueManualImprove(store, clock, PROJECT_KEY, "n-1")).created).toBe(false);
    await controller.tickImprove();
    const runs = await improveRuns(store);
    expect(runs.filter((r) => r.id === manual.run.id)).toHaveLength(1);
    expect(runs.filter((r) => r.idempotency_key === dailyImproveKey(PROJECT_KEY, "2026-03-10"))).toHaveLength(1);
    expect(manual.run.input?.improve).toEqual({ start: new Date(clock.now().getTime() - DAY_MS).toISOString(), end: clock.now().toISOString() });
  });

  it("a manual run before the day's tick does not take the day's slot", async () => {
    const { store, controller, clock } = await setup("2026-03-10T08:00:00.000Z");
    await enqueueManualImprove(store, clock, PROJECT_KEY, "n-1");
    const daily = await enqueueDailyImprove(store, clock, PROJECT_KEY);
    expect(daily.created).toBe(true);
    await controller.tickImprove();
    expect(await improveRuns(store)).toHaveLength(2);
  });
});

describe("grouping", () => {
  const window = dailyWindow("2026-03-10");
  const at = (h: number) => new Date(Date.parse(window.start) + h * 3_600_000).toISOString() as Timestamp;
  const run = (id: string, item: string, code: string, detail: string, finished: Timestamp | null): Run =>
    ({
      id, work_item_id: item as WorkItemId, kind: "implement", status: "failed", finished_at: finished,
      outcome: { status: "failed", error_code: code, detail, infra: false },
    }) as unknown as Run;
  const fixture = [
    run("run_a", "wi_1", "checks_failed", "npm test exited 1 after 12034 ms (sha 3f9a2c1d)", at(1)),
    run("run_b", "wi_2", "checks_failed", "npm test exited 2 after 998 ms (sha 77ab01ce)", at(2)),
    run("run_c", "wi_1", "checks_failed", "NPM test   exited 1 after 5 ms (sha deadbeef1)", at(3)),
    run("run_d", "wi_3", "scope_violation", "src/x.ts is outside the allowed paths", at(4)),
  ];

  it("four failed runs, three sharing a code and normalized detail: one group of three, one one-run pattern", () => {
    const r = groupFailures(fixture, window);
    expect(r.groups).toEqual([
      { error_code: "checks_failed", detail: "npm test exited <n> after <n> ms (sha <id>)", run_ids: ["run_a", "run_b", "run_c"], work_item_ids: ["wi_1", "wi_2"] },
    ]);
    expect(r.singles).toEqual([
      { error_code: "scope_violation", detail: "src/x.ts is outside the allowed paths", run_ids: ["run_d"], work_item_ids: ["wi_3"] },
    ]);
    expect([r.window_start, r.window_end]).toEqual([window.start, window.end]);
  });

  it("is deterministic: the same runs in any order give an identical report", () => {
    const a = groupFailures(fixture, window);
    const b = groupFailures([...fixture].reverse(), window);
    const c = groupFailures([fixture[2]!, fixture[0]!, fixture[3]!, fixture[1]!], window);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("counts no run that finished outside the window, and no run that did not fail", () => {
    const outside = [
      run("run_e", "wi_4", "checks_failed", "npm test exited 1 after 1 ms (sha 3f9a2c1d)", at(-1)),
      run("run_f", "wi_4", "checks_failed", "npm test exited 1 after 1 ms (sha 3f9a2c1d)", window.end),
      run("run_g", "wi_4", "checks_failed", "npm test exited 1 after 1 ms (sha 3f9a2c1d)", null),
      { ...run("run_h", "wi_4", "x", "y", at(5)), status: "succeeded", outcome: { status: "succeeded", summary: "", data: {} } } as Run,
    ];
    const r = groupFailures([...fixture, ...outside], window);
    expect(JSON.stringify(r)).toBe(JSON.stringify(groupFailures(fixture, window)));
  });

  it("normalizes ids, numbers, times, case and spacing, and keeps different text apart", () => {
    expect(normalizeDetail("Run wi_0ce93bc78b114bbe at 2026-03-09T01:02:03.456Z:  exit 137")).toBe("run wi_<id> at <time>: exit <n>");
    expect(normalizeDetail("x".repeat(500))).toHaveLength(200);
    expect(normalizeDetail("lease lost")).not.toBe(normalizeDetail("lease kept"));
  });
});

describe("the improve run", () => {
  it("is claimed like any run, calls no model, stores one report of its window and files no pattern", async () => {
    const { store, controller, worker, runner, sandbox, clock } = await setup("2026-03-08T23:00:00.000Z");
    const before = await failedRun(store, 9, "checks_failed", "npm test exited 1 after 40 ms");
    clock.advance(2 * 3_600_000); // 2026-03-09T01:00Z: inside the window of 2026-03-10's run
    const a = await failedRun(store, 1, "checks_failed", "npm test exited 1 after 40 ms");
    clock.advance(60_000);
    const b = await failedRun(store, 2, "checks_failed", "npm test exited 3 after 512 ms");
    clock.advance(60_000);
    const c = await failedRun(store, 3, "checks_failed", "NPM test exited 1 after 9 ms");
    clock.advance(60_000);
    const d = await failedRun(store, 4, "scope_violation", "src/x.ts is outside the allowed paths");
    clock.advance(31 * 3_600_000); // 2026-03-10T08:03Z
    await controller.tickImprove();

    expect(await worker.tick()).toBe(true);
    const [run] = await improveRuns(store);
    expect(run!.status).toBe("succeeded");
    expect(runner.calls).toBe(0);
    expect(sandbox.created).toHaveLength(0);

    const report = (await store.getImproveReport(run!.id))!;
    expect(report).toMatchObject({ run_id: run!.id, project: PROJECT_KEY, window_start: "2026-03-09T00:00:00.000Z", window_end: "2026-03-10T00:00:00.000Z" });
    expect(report.groups).toEqual([
      { error_code: "checks_failed", detail: "npm test exited <n> after <n> ms", run_ids: [a.id, b.id, c.id].sort(), work_item_ids: [a.work_item_id, b.work_item_id, c.work_item_id].sort() },
    ]);
    expect(report.singles).toEqual([
      { error_code: "scope_violation", detail: "src/x.ts is outside the allowed paths", run_ids: [d.id], work_item_ids: [d.work_item_id] },
    ]);
    const counted = [...report.groups, ...report.singles].flatMap((g) => g.run_ids);
    expect(counted).not.toContain(before.id);

    const tables = await store.listTables();
    expect(tables.find((t) => t.name === "filed_patterns")?.rows).toBe(0);
    expect(tables.find((t) => t.name === "improve_reports")?.rows).toBe(1);
  });

  it("the controller acks it without changing the system item", async () => {
    const { store, controller, worker, clock } = await setup("2026-03-10T08:00:00.000Z");
    await controller.tickImprove();
    const [queued] = await improveRuns(store);
    const item = (await store.getWorkItem(queued!.work_item_id))!;
    await worker.tick();
    clock.advance(1_000);
    await controller.tickRuns();
    const run = (await store.getRun(queued!.id))!;
    expect(run.acknowledged_at).not.toBeNull();
    const after = (await store.getWorkItem(item.id))!;
    expect({ ...after, version: 0, updated_at: null }).toEqual({ ...item, version: 0, updated_at: null });
    expect((await store.listStateChanges(item.id)).map((c) => c.reason)).toContain("improve_reported");
    expect(await store.listRunsByKind("improve", ["queued"])).toHaveLength(0);
  });

  it("a rerun of the same run stores nothing new", async () => {
    const { store, clock } = await setup("2026-03-10T08:00:00.000Z");
    await failedRun(store, 1, "checks_failed", "x");
    clock.advance(1_000); // the window's end is exclusive
    const { run } = await enqueueManualImprove(store, clock, PROJECT_KEY, "n");
    const item = (await store.getWorkItem(run.work_item_id))!;
    const first = await runImprove(store, run, item);
    const second = await runImprove(store, run, item);
    expect(first).toEqual({ groups: 0, singles: 1, created: true });
    expect(second).toEqual({ groups: 0, singles: 1, created: false });
  });
});
