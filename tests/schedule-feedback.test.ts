// The feedback schedule action (design 08-schedules), through the `routed` ScheduleAction and the scheduler's claim
// pass, with the fake runner standing in for AgentRunner: no test here calls a model. A feedback occurrence runs one
// read-only agent, files at most 3 evidence-backed tasks as local work items and records the rest on its run row.

import { describe, expect, it } from "vitest";
import { agentAction } from "../src/controller/units/schedule/plugins/agent/agent-action.js";
import { buildAction } from "../src/controller/units/schedule/plugins/build/build-action.js";
import { FEEDBACK_MAX_TASKS, feedbackAction } from "../src/controller/units/schedule/plugins/feedback/feedback-action.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { type AddScheduleInput, type ScheduleActionSpec, addSchedule } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { RoutedScheduleAction } from "../src/impl/schedule-action/routed-action.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { READ_TOOLS } from "../src/worker/index.js";
import { silent } from "./helpers/fakes/config.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";

const ME = "local:owner" as UserId;
const PROJECT = "local:here:repo";
const SLOT = "2026-11-23T00:00:00.000Z";
const LEAK = "sk-leaked-value-123";

/** A store with one daily schedule doing `action`, and the scheduler pass bound to the routed action over the fake runner. */
async function setup(action: ScheduleActionSpec, answer: (spec: AgentRunSpec) => Partial<AgentRunResult>, tools = READ_TOOLS) {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  const input: AddScheduleInput = { id: "sch_a", title: "Nightly look", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME, action };
  expect(await addSchedule(store, input, clock.now())).toMatchObject({ ok: true });
  const runner = new FakeRunner({ triage: async (spec) => answer(spec) });
  const loaded = { config: { repo: { path: "/repo", base_branch: "main" }, deny_paths: [], run_timeout_ms: 60_000 } };
  const ctx = {
    loaded, repo: { owner: "o", name: "r" }, extraScanValues: [], store, runner, sandbox: new FakeSandbox(), tools,
    scanner: new PatternEgressScanner(async () => [LEAK]), project: PROJECT, routes: { build: buildAction, agent: agentAction, feedback: feedbackAction },
  };
  const routed = new RoutedScheduleAction(ctx as never);
  const pass = scheduledAction(store, routed, silent, PROJECT);
  return { store, runner, routed, fire: () => pass.fireDue(new Date(SLOT)) };
}

/** A task the feedback agent reports: with evidence unless `evidence` is false. */
const task = (n: number, evidence = true) => ({
  title: `Task ${n}`, body: `Fix thing ${n}`, evidence: evidence ? [{ path: `src/a${n}.ts`, line: n, quote: `bad(${n})` }] : [],
});

describe("the feedback action", () => {
  it("files at most 3 evidence-backed tasks per occurrence and records the rest on its run", async () => {
    const tasks = [task(1), task(2, false), task(3), task(4), task(5)];
    const { store, runner, fire } = await setup({ kind: "feedback", settings: { prompt: "Review the settings page" } }, () => ({ output: { tasks } }));
    await fire();
    expect(FEEDBACK_MAX_TASKS).toBe(3);
    const spec = runner.specs[0]!;
    expect(spec.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    expect(spec.output_schema).toBeDefined();
    expect(spec.prompt).toContain("Review the settings page");
    const out = JSON.parse((await store.listScheduleRuns("sch_a"))[0]!.output!) as { filed: { id: string; title: string }[]; unfiled: { title: string; reason: string }[] };
    expect(out.filed.map((f) => f.title)).toEqual(["Task 1", "Task 3", "Task 4"]);
    expect(out.unfiled).toEqual([{ title: "Task 2", reason: "no_evidence" }, { title: "Task 5", reason: "over_cap" }]);
    const items = await Promise.all(out.filed.map((f) => store.getWorkItem(f.id as never)));
    expect(items.map((i) => [i!.source.type, i!.title, i!.project])).toEqual([["local", "Task 1", PROJECT], ["local", "Task 3", PROJECT], ["local", "Task 4", PROJECT]]);
    expect(items[0]!.problem).toContain("`src/a1.ts:1`: bad(1)");
    await store.close();
  });

  it("running the same occurrence again files no task twice and never more than the cap", async () => {
    let call = 0;
    const { store, routed, fire } = await setup({ kind: "feedback", settings: { prompt: "Review", max_tasks: 2 } }, () => ({ output: { tasks: call++ === 0 ? [task(1), task(2)] : [task(7), task(8), task(9)] } }));
    await fire();
    expect((await store.listWorkItems(50)).map((i) => i.title).sort()).toEqual(["Task 1", "Task 2"]);
    // A crash after the claim hands the same occurrence over again: the model answers differently, nothing more is filed.
    await routed.run((await store.listSchedules())[0]!, SLOT as never);
    expect((await store.listWorkItems(50)).map((i) => i.title).sort()).toEqual(["Task 1", "Task 2"]);
    const out = JSON.parse((await store.listScheduleRuns("sch_a"))[0]!.output!) as { filed: { created: boolean }[]; unfiled: { reason: string }[] };
    expect(out.filed.map((f) => f.created)).toEqual([false, false]);
    expect(out.unfiled.map((u) => u.reason)).toEqual(["over_cap"]);
    await store.close();
  });

  it("files nothing from an answer the leak scanner flags", async () => {
    const { store, fire } = await setup({ kind: "feedback", settings: { prompt: "Review" } }, () => ({ output: { tasks: [task(1), { ...task(2), body: `use ${LEAK}` }] } }));
    await fire();
    expect(await store.listWorkItems(50)).toEqual([]);
    const out = JSON.parse((await store.listScheduleRuns("sch_a"))[0]!.output!) as { filed: unknown[] };
    expect(out.filed).toEqual([]);
    expect(JSON.stringify(await store.listScheduleRuns("sch_a"))).not.toContain(LEAK);
    await store.close();
  });
});
