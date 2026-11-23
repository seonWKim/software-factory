// The build schedule action (design 08-schedules): each fired occurrence files exactly one local work item, its
// source ID from the schedule's ID and the slot, with its triage run queued; running the same occurrence again
// files none. It calls no model: the fake runner has no script, so any agent call would fail the occurrence.

import { describe, expect, it } from "vitest";
import { agentAction } from "../src/controller/units/schedule/plugins/agent/agent-action.js";
import { buildAction, buildSourceId } from "../src/controller/units/schedule/plugins/build/build-action.js";
import { feedbackAction } from "../src/controller/units/schedule/plugins/feedback/feedback-action.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { type ScheduleActionSpec, addSchedule } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { RoutedScheduleAction } from "../src/impl/schedule-action/routed-action.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { READ_TOOLS } from "../src/worker/index.js";
import { silent } from "./helpers/fakes/config.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";

const ME = "local:owner" as UserId;
const PROJECT = "local:here:repo";
const HOUR = 3_600_000;
const FIRST = "2026-11-23T00:00:00.000Z";
const LEAK = "sk-leaked-value-123";

async function setup(action: ScheduleActionSpec) {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  await addSchedule(store, { id: "sch_b", title: "Weekly dependency bump", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME, action }, clock.now());
  const runner = new FakeRunner({});
  const ctx = {
    loaded: { config: { repo: { path: "/repo", base_branch: "main" }, deny_paths: [], run_timeout_ms: 60_000 } }, repo: { owner: "o", name: "r" }, extraScanValues: [],
    store, runner, sandbox: new FakeSandbox(), tools: READ_TOOLS, scanner: new PatternEgressScanner(async () => [LEAK]), project: PROJECT,
    routes: { build: buildAction, agent: agentAction, feedback: feedbackAction },
  };
  const routed = new RoutedScheduleAction(ctx as never);
  const warned: string[] = [];
  const pass = scheduledAction(store, routed, { ...silent, warn: (m: string) => void warned.push(m) }, PROJECT);
  return { store, runner, routed, pass, warned };
}

describe("the build action", () => {
  it("files exactly one work item per occurrence, with its triage run queued, and calls no model", async () => {
    const { store, runner, pass, warned } = await setup({ kind: "build", settings: { body: "Bump the lock file." } });
    await pass.fireDue(new Date(FIRST));
    await pass.fireDue(new Date(Date.parse(FIRST) + 24 * HOUR));
    expect(warned).toEqual([]);
    expect(runner.specs).toEqual([]);
    const items = await store.listWorkItems(50);
    expect(items.map((i) => i.source.id).sort()).toEqual([buildSourceId("sch_b", FIRST), buildSourceId("sch_b", "2026-11-24T00:00:00.000Z")].sort());
    expect(items.map((i) => [i.title, i.project, i.requester_id, i.source.type])).toEqual([
      ["Weekly dependency bump", PROJECT, ME, "local"], ["Weekly dependency bump", PROJECT, ME, "local"],
    ]);
    expect(items[0]!.problem).toBe("Weekly dependency bump\n\nBump the lock file.");
    expect((await store.listRuns(items[0]!.id)).map((r) => r.kind)).toEqual(["triage"]);
    const runs = await store.listScheduleRuns("sch_b");
    expect(runs.map((r) => [r.outcome, r.tokens])).toEqual([["fired", 0], ["fired", 0]]);
    expect(runs[0]!.output).toMatch(/^filed wi_/);
    await store.close();
  });

  it("running the same occurrence again creates no work item", async () => {
    const { store, routed, pass } = await setup({ kind: "build", settings: { title: "Release notes" } });
    await pass.fireDue(new Date(FIRST));
    const [item] = await store.listWorkItems(50);
    // A crash after the claim may hand the same occurrence over again, and a second tick at the slot claims nothing.
    await routed.run((await store.listSchedules())[0]!, FIRST as never);
    await pass.fireDue(new Date(FIRST));
    expect((await store.listWorkItems(50)).map((i) => i.id)).toEqual([item!.id]);
    expect(item!.title).toBe("Release notes");
    expect((await store.listRuns(item!.id)).map((r) => r.kind)).toEqual(["triage"]);
    expect((await store.listScheduleRuns("sch_b"))[0]!.output).toBe(`already filed ${item!.id}`);
    await store.close();
  });

  it("files nothing when the leak scanner flags its body, and the failure is logged", async () => {
    const { store, pass, warned } = await setup({ kind: "build", settings: { body: `token ${LEAK}` } });
    await pass.fireDue(new Date(FIRST));
    expect(await store.listWorkItems(50)).toEqual([]);
    expect(warned).toEqual(["schedule action failed"]);
    expect((await store.listSchedules())[0]!.running_since).toBeNull();
    await store.close();
  });
});
