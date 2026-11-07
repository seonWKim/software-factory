import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import {
  SYSTEM_ITEM, dailyImproveKey, enqueueImprove, groupFailures, systemSource, utcDay,
} from "../src/core/improver.js";
import { Worker } from "../src/core/worker.js";
import type { Run, RunId, Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider } from "../src/interfaces/llm-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeAuth, FakeBroker, FakeSandbox, MemoryStorage, PROJECT, cleanScanner, config, prompts, silent } from "./helpers/fakes.js";

const DAY = 86_400_000;

/** A failed run as the store returns it, for the pure grouping. */
function failed(id: string, item: string, code: string, detail: string, finished_at: string): Run {
  return {
    id: id as RunId, work_item_id: item as WorkItemId, kind: "implement", status: "failed", finished_at: finished_at as Timestamp,
    outcome: { status: "failed", error_code: code, detail, infra: false },
  } as Run;
}

/** Four failed runs: three share a code and a detail that differs only in numbers and a sha, one is different. */
const FIXTURE: readonly Run[] = [
  failed("run_a", "wi_1", "checks_failed", "npm test exited 1: 3 failing tests in tests/x.test.ts:12 at abc1234", "2026-01-01T01:00:00.000Z"),
  failed("run_b", "wi_2", "checks_failed", "npm test exited 2: 15 failing tests in tests/x.test.ts:40 at 9f8e7d6c5b", "2026-01-01T02:00:00.000Z"),
  failed("run_c", "wi_1", "checks_failed", "npm  test exited 1:  7 failing tests in tests/x.test.ts:3 at deadbeef1", "2026-01-01T03:00:00.000Z"),
  failed("run_d", "wi_3", "diff_too_large", "1200 lines over max_diff_lines", "2026-01-01T04:00:00.000Z"),
];

describe("improve: grouping", () => {
  it("one group of the three runs that share a code and normalized detail, one one-run pattern", () => {
    const { groups, patterns } = groupFailures(FIXTURE);
    expect(groups).toEqual([
      {
        error_code: "checks_failed",
        detail: "npm test exited #: # failing tests in tests/x.test.ts:# at <id>",
        run_ids: ["run_a", "run_b", "run_c"],
        work_item_ids: ["wi_1", "wi_2"],
      },
    ]);
    expect(patterns).toEqual([{ error_code: "diff_too_large", detail: "# lines over max_diff_lines", run_ids: ["run_d"], work_item_ids: ["wi_3"] }]);
  });

  it("is deterministic: the same runs in any order give an identical report", () => {
    const expected = JSON.stringify(groupFailures(FIXTURE));
    expect(JSON.stringify(groupFailures([...FIXTURE].reverse()))).toBe(expected);
    expect(JSON.stringify(groupFailures([FIXTURE[2]!, FIXTURE[0]!, FIXTURE[3]!, FIXTURE[1]!]))).toBe(expected);
  });
});

/** A controller with no source: the daily improve step needs only the store. */
function controller(store: FactoryStore, clock: FakeClock): Controller {
  return new Controller({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
}

async function improveRuns(store: FactoryStore): Promise<Run[]> {
  const item = await store.getWorkItemBySource("local", systemSource(PROJECT.key).id);
  return item ? (await store.listRuns(item.id)).filter((r) => r.kind === "improve") : [];
}

describe("improve: scheduling", () => {
  it("the daily tick queues one improve run for the current UTC day; another tick that day, on any replica, queues none", async () => {
    const clock = new FakeClock("2026-03-04T08:30:00.000Z");
    const { store } = await newStore(clock);
    const c = controller(store, clock);
    await c.tickImprove();
    await c.tickImprove();
    clock.advance(10 * 60 * 60_000); // still 2026-03-04 (18:30 UTC)
    await controller(store, clock).tickImprove();
    const runs = await improveRuns(store);
    expect(runs.map((r) => r.idempotency_key)).toEqual([dailyImproveKey(PROJECT.key, "2026-03-04")]);
    // The day before, in full.
    expect(runs[0]!.input?.improve).toEqual({ window_start: "2026-03-03T00:00:00.000Z", window_end: "2026-03-04T00:00:00.000Z" });
    // The system work item: held for good, never triaged.
    const item = (await store.getWorkItem(runs[0]!.work_item_id))!;
    expect(item).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: SYSTEM_ITEM, project: PROJECT.key });

    clock.advance(DAY);
    await c.tickImprove();
    expect((await improveRuns(store)).map((r) => r.idempotency_key)).toContain(dailyImproveKey(PROJECT.key, "2026-03-05"));
  });

  it("factory improve queues exactly one run with a key of its own, so the day's slot still gets its run", async () => {
    const clock = new FakeClock("2026-03-04T08:30:00.000Z");
    const { store } = await newStore(clock);
    const manual = await enqueueImprove({ store, clock }, PROJECT.key, "manual");
    expect(manual.created).toBe(true);
    expect(manual.run.idempotency_key).not.toBe(dailyImproveKey(PROJECT.key, utcDay(clock.now())));
    expect((await improveRuns(store)).map((r) => r.id)).toEqual([manual.run.id]);
    await controller(store, clock).tickImprove();
    const keys = (await improveRuns(store)).map((r) => r.idempotency_key);
    expect(keys).toContain(manual.run.idempotency_key);
    expect(keys).toContain(dailyImproveKey(PROJECT.key, "2026-03-04"));
    // One system work item for both.
    expect(new Set((await improveRuns(store)).map((r) => r.work_item_id)).size).toBe(1);
  });
});

/** A runner and an LLM that fail the test if anything calls them: a worker with no LLM provider asks no model. */
const noRunner: AgentRunner = {
  run: () => {
    throw new Error("the improve run called the agent runner");
  },
} as unknown as AgentRunner;
const noLlm: LLMProvider = {
  complete: () => {
    throw new Error("the improve run called the model");
  },
} as unknown as LLMProvider;

class NoSandbox extends FakeSandbox {
  override create(): never {
    throw new Error("the improve run made a sandbox");
  }
}

/** Fails a triage run of a new item `n` with `code` and `detail`, at the clock's time. */
async function failRun(store: FactoryStore, n: number, code: string, detail: string): Promise<RunId> {
  await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail, infra: false });
  return run.id;
}

describe("improve: the run", () => {
  it("a worker with no LLM provider claims it like any run and stores one report of the window; no model is called, nothing is filed", async () => {
    const clock = new FakeClock("2026-03-03T06:00:00.000Z");
    const { store } = await newStore(clock);
    // Before the window: not counted.
    await failRun(store, 1, "checks_failed", "npm test exited 1: 2 failing tests");
    clock.set("2026-03-04T01:00:00.000Z");
    const in1 = await failRun(store, 2, "checks_failed", "npm test exited 1: 3 failing tests");
    clock.advance(60_000);
    const in2 = await failRun(store, 3, "checks_failed", "npm test exited 1: 9 failing tests");
    clock.advance(60_000);
    const in3 = await failRun(store, 4, "agent_timed_out", "no answer in 1800000 ms");
    clock.set("2026-03-05T00:00:01.000Z");
    // After the window (the improve day itself): not counted either.
    await failRun(store, 5, "checks_failed", "npm test exited 1: 4 failing tests");

    const c = new Controller({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, llm: noLlm });
    await c.tickImprove();
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new NoSandbox(), runner: noRunner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    expect(await worker.tick()).toBe(true);

    const [run] = await improveRuns(store);
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    const report = (await store.getImproveReport(run!.id))!;
    expect(report).toMatchObject({
      run_id: run!.id,
      project: PROJECT.key,
      window_start: "2026-03-04T00:00:00.000Z",
      window_end: "2026-03-05T00:00:00.000Z",
    });
    expect(report.groups.map((g) => [g.error_code, g.run_ids])).toEqual([["checks_failed", [in1, in2]]]);
    expect(report.groups[0]!.work_item_ids).toHaveLength(2);
    expect(report.patterns.map((g) => [g.error_code, g.run_ids])).toEqual([["agent_timed_out", [in3]]]);
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { report_id: report.id, groups: 1, patterns: 1, tokens: 0 } });
    expect((await store.listTables()).find((t) => t.name === "filed_patterns")!.rows).toBe(0);

    // The controller acknowledges it and leaves the system item as it was.
    const before = (await store.getWorkItem(run!.work_item_id))!;
    await c.tickRuns();
    expect((await store.getRun(run!.id))!.acknowledged_at).not.toBeNull();
    expect(await store.getWorkItem(run!.work_item_id)).toMatchObject({ stage: before.stage, blocked_reason: SYSTEM_ITEM });
  });
});
