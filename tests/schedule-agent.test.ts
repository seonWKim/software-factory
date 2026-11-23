// The agent schedule action (design 08-schedules), through the `routed` ScheduleAction and the scheduler's claim
// pass, with the fake runner standing in for AgentRunner: no test here calls a model. An agent occurrence runs its
// prompt once with Read, Glob and Grep only and keeps the answer and its cost on the run row.

import { describe, expect, it } from "vitest";
import { agentAction } from "../src/controller/units/schedule/plugins/agent/agent-action.js";
import { buildAction } from "../src/controller/units/schedule/plugins/build/build-action.js";
import { feedbackAction } from "../src/controller/units/schedule/plugins/feedback/feedback-action.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { type AddScheduleInput, type ScheduleActionSpec, addSchedule } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { RoutedScheduleAction, SCHEDULE_AGENT_TOOLS } from "../src/impl/schedule-action/routed-action.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { READ_TOOLS, WRITE_TOOLS } from "../src/worker/index.js";
import { silent } from "./helpers/fakes/config.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";

const ME = "local:owner" as UserId;
const PROJECT = "local:here:repo";
const DENY = ["~/.config/software-factory", "~/.ssh"];
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
  const loaded = { config: { repo: { path: "/repo", base_branch: "main" }, deny_paths: DENY, run_timeout_ms: 60_000 } };
  const ctx = {
    loaded, repo: { owner: "o", name: "r" }, extraScanValues: [], store, runner, sandbox: new FakeSandbox(), tools,
    scanner: new PatternEgressScanner(async () => [LEAK]), project: PROJECT, routes: { build: buildAction, agent: agentAction, feedback: feedbackAction },
  };
  const routed = new RoutedScheduleAction(ctx as never);
  const pass = scheduledAction(store, routed, silent, PROJECT);
  return { store, runner, routed, fire: () => pass.fireDue(new Date(SLOT)) };
}

describe("the agent action", () => {
  it("runs its prompt once with Read, Glob and Grep, and stores the output and cost on its run", async () => {
    const usage = { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 500, cost_usd: 0.42 };
    const { store, runner, fire } = await setup({ kind: "agent", settings: { prompt: "Summarise the open TODOs" } }, () => ({ output: { summary: "3 TODOs" }, usage }));
    await fire();
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]!.prompt).toBe("Summarise the open TODOs");
    expect(runner.specs[0]!.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    const [run] = await store.listScheduleRuns("sch_a");
    expect(run).toMatchObject({ occurrence_at: SLOT, outcome: "fired", output: JSON.stringify({ summary: "3 TODOs" }), tokens: 2000, cost_usd: 0.42 });
    expect(await store.scheduleTokensUsed("sch_a")).toBe(2000);
    await store.close();
  });

  it("gives the agent no write or exec tool, no writable path and every deny_paths entry", async () => {
    const { store, runner, fire } = await setup({ kind: "agent", settings: { prompt: "Look" } }, () => ({ output: "ok" }));
    await fire();
    const spec = runner.specs[0]!;
    expect(SCHEDULE_AGENT_TOOLS).toEqual(["Read", "Glob", "Grep"]);
    expect(spec.tools.every((t) => t.capability === "read")).toBe(true);
    expect(spec.tools.some((t) => t.capability === "write" || t.capability === "exec")).toBe(false);
    expect(spec.writable_paths).toEqual([]);
    expect(spec.readable_paths).toBeUndefined();
    expect(spec.tool_grants).toEqual([]);
    expect(spec.env_allowlist).toEqual({});
    expect(spec.deny_paths).toEqual(DENY);
    await store.close();
  });

  it("refuses to start an agent when it is given a write tool in place of a read tool", async () => {
    const { store, runner, fire } = await setup({ kind: "agent", settings: { prompt: "Look" } }, () => ({ output: "ok" }), WRITE_TOOLS.map((t) => (t.name === "Grep" ? { ...t, capability: "exec" as const } : t)));
    await fire();
    expect(runner.specs).toEqual([]);
    expect((await store.listSchedules())[0]!.running_since).toBeNull();
    await store.close();
  });

  it("withholds an answer the leak scanner flags, and stores a failed call's status", async () => {
    const leaked = await setup({ kind: "agent", settings: { prompt: "Look" } }, () => ({ output: { text: LEAK } }));
    await leaked.fire();
    const [run] = await leaked.store.listScheduleRuns("sch_a");
    expect(run!.output).toMatch(/^\(withheld: the leak scanner flagged the answer/);
    expect(run!.output).not.toContain(LEAK);
    await leaked.store.close();

    const failed = await setup({ kind: "agent", settings: { prompt: "Look" } }, () => ({ status: "timed_out", usage: { input_tokens: 7, output_tokens: 3, cost_usd: null } }));
    await failed.fire();
    expect((await failed.store.listScheduleRuns("sch_a"))[0]).toMatchObject({ output: "agent run timed_out", tokens: 10 });
    expect((await failed.store.listSchedules())[0]!.running_since).toBeNull();
    await failed.store.close();
  });
});
