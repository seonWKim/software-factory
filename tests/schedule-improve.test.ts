// The improve schedule action (design 08-schedules, 07-self-improvement): an occurrence queues the daily improve run
// of its slot's UTC day under the controller's daily key, so a second occurrence that day queues none. Setup adds
// the Daily improve run schedule once when `improver.daily_trigger` is off; `schedule add` and `edit` still refuse
// the improve kind. No model and no remote service: the fake runner has no script.

import { describe, expect, it } from "vitest";
import { addImproveSchedule, type ImproveScheduleDeps } from "../src/cli/handlers/setup/guided.js";
import { agentAction } from "../src/controller/units/schedule/plugins/agent/agent-action.js";
import { buildAction } from "../src/controller/units/schedule/plugins/build/build-action.js";
import { feedbackAction } from "../src/controller/units/schedule/plugins/feedback/feedback-action.js";
import { improveAction } from "../src/controller/units/schedule/plugins/improve/improve-action.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { dailyImproveKey, dailyWindow, enqueueImprove, listImproveRuns } from "../src/core/improver.js";
import { improverConfig, improverProblems } from "../src/core/proposals.js";
import { type NewSchedule, type Schedule, addSchedule, writeSchedule } from "../src/core/schedule.js";
import type { Timestamp, UserId } from "../src/core/types.js";
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

async function newStore() {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  return { clock, store };
}

async function routed() {
  const { clock, store } = await newStore();
  // Every two hours, so two occurrences fall on one UTC day.
  await addSchedule(store, { id: "improve-daily", title: "Daily improve run", cadence: { kind: "interval", spec: "120" }, zone: "UTC", created_by: ME, action: { kind: "improve", settings: {} } }, clock.now());
  const runner = new FakeRunner({});
  const ctx = {
    loaded: { config: { repo: { path: "/repo", base_branch: "main" }, deny_paths: [], run_timeout_ms: 60_000 } }, repo: { owner: "o", name: "r" }, extraScanValues: [],
    store, runner, sandbox: new FakeSandbox(), tools: READ_TOOLS, scanner: new PatternEgressScanner(async () => []), project: PROJECT,
    routes: { build: buildAction, agent: agentAction, feedback: feedbackAction, improve: improveAction((slot) => enqueueImprove({ store, clock }, PROJECT, { slot })) },
  };
  const action = new RoutedScheduleAction(ctx as never);
  const warned: string[] = [];
  const pass = scheduledAction(store, action, { ...silent, warn: (m: string) => void warned.push(m) }, PROJECT);
  return { store, runner, action, pass, warned };
}

describe("the improve action", () => {
  it("an occurrence queues exactly one improve run keyed by its slot's UTC day; a second occurrence that day queues none", async () => {
    const { store, runner, pass, warned } = await routed();
    await pass.fireDue(new Date("2026-11-22T14:00:00.000Z"));
    await pass.fireDue(new Date("2026-11-22T16:00:00.000Z"));
    expect(warned).toEqual([]);
    expect(runner.specs).toEqual([]);
    const runs = await listImproveRuns(store, PROJECT);
    expect(runs.map((r) => r.idempotency_key)).toEqual([dailyImproveKey(PROJECT, "2026-11-22")]);
    expect(runs[0]!.input?.improve).toEqual(dailyWindow("2026-11-22"));
    const rows = await store.listScheduleRuns("improve-daily");
    expect(rows.map((r) => r.outcome)).toEqual(["fired", "fired"]);
    expect(rows[0]!.output).toBe(`queued improve run ${runs[0]!.id} (${dailyImproveKey(PROJECT, "2026-11-22")})`);
    expect(rows[1]!.output).toBe(`already queued improve run ${runs[0]!.id} (${dailyImproveKey(PROJECT, "2026-11-22")})`);
    await store.close();
  });

  it("the day is the slot's, not the time it ran: a slot just before midnight UTC run after it keys the earlier day", async () => {
    const { store, action } = await routed();
    const s = (await store.listSchedules())[0]!;
    await action.run(s, "2026-11-22T23:59:00.000Z" as Timestamp);
    await action.run(s, "2026-11-23T00:01:00.000Z" as Timestamp);
    expect((await listImproveRuns(store, PROJECT)).map((r) => r.idempotency_key)).toEqual([
      dailyImproveKey(PROJECT, "2026-11-22"), dailyImproveKey(PROJECT, "2026-11-23"),
    ]);
    await store.close();
  });
});

describe("improver.daily_trigger", () => {
  it("is a boolean: unset or true is on, false is off, any other value fails startup naming the key", () => {
    expect(improverConfig({}).daily_trigger).toBeUndefined();
    expect(improverConfig({ improver: { daily_trigger: false } }).daily_trigger).toBe(false);
    expect(improverConfig({ improver: { daily_trigger: true } }).daily_trigger).toBe(true);
    for (const bad of ["no", 0, null, {}]) {
      expect(() => improverConfig({ improver: { daily_trigger: bad } }), String(bad)).toThrow(/improver\.daily_trigger/);
      expect(improverProblems({ improver: { daily_trigger: bad } }).join("\n")).toMatch(/improver\.daily_trigger/);
    }
  });
});

/** A fake schedule store: the setup step's reads and its insert. */
function fakeStore(o: { owner?: UserId | null; stored?: string[] } = {}) {
  const rows: Schedule[] = (o.stored ?? []).map((id) => ({ id } as Schedule));
  const store: ImproveScheduleDeps["store"] = {
    getOwner: async () => (o.owner === undefined ? ME : o.owner),
    listSchedules: async () => rows,
    addSchedule: async (s: NewSchedule) => {
      const row = { running_since: null, skip_when_busy: false, action: null, token_cap: null, ...s } as Schedule;
      rows.push(row);
      return row;
    },
  };
  return { store, rows };
}

function deps(over: Partial<ImproveScheduleDeps> & { daily_trigger?: boolean | undefined; schedule_action?: string } = {}) {
  const lines: string[] = [];
  const { daily_trigger, schedule_action, ...rest } = over;
  const d: ImproveScheduleDeps = {
    store: fakeStore().store,
    config: { improver: improverConfig(daily_trigger === undefined ? {} : { improver: { daily_trigger } }) },
    plugins: schedule_action === undefined ? {} : { schedule_action },
    zone: "Asia/Seoul",
    now: new Date("2026-11-22T12:00:00.000Z"),
    print: (l) => void lines.push(l),
    ...rest,
  };
  return { d, lines };
}

describe("setup: the Daily improve run schedule", () => {
  it("with the flag off adds improve-daily once: Daily improve run, action improve, daily 09:00 in the machine's zone, by the owner", async () => {
    const { store, rows } = fakeStore();
    const { d } = deps({ store, daily_trigger: false, schedule_action: "routed" });
    expect((await addImproveSchedule(d)).ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "improve-daily", title: "Daily improve run", action: { kind: "improve", settings: {} },
      cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME,
    });
    // Run again: the ID is stored, nothing more is added.
    const again = await addImproveSchedule(d);
    expect(again.ok).toBe(true);
    expect(again.line).toMatch(/already stored/);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
  });

  it("adds nothing when the ID is stored already, or when the flag is on or unset", async () => {
    for (const daily_trigger of [true, undefined]) {
      const { store, rows } = fakeStore();
      expect((await addImproveSchedule(deps({ store, daily_trigger, schedule_action: "routed" }).d)).ok).toBe(true);
      expect(rows, String(daily_trigger)).toEqual([]);
    }
    const { store, rows } = fakeStore({ stored: ["improve-daily"] });
    await addImproveSchedule(deps({ store, daily_trigger: false, schedule_action: "routed" }).d);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
  });

  it("with plugins.schedule_action not routed, warns naming it and still adds the schedule", async () => {
    const { store, rows } = fakeStore();
    const { d, lines } = deps({ store, daily_trigger: false });
    expect((await addImproveSchedule(d)).ok).toBe(true);
    expect(lines.join("\n")).toMatch(/plugins\.schedule_action/);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
    // Routed: no warning.
    const routedRun = deps({ store: fakeStore().store, daily_trigger: false, schedule_action: "routed" });
    await addImproveSchedule(routedRun.d);
    expect(routedRun.lines).toEqual([]);
  });
});

describe("schedule add and schedule edit refuse the improve kind", () => {
  const fields = { title: "t", cadence: "daily", spec: "09:00", zone: "UTC" };

  it("add accepts build, agent and feedback, and refuses improve with a reason", async () => {
    const { store } = await newStore();
    const now = new Date("2026-11-22T12:00:00.000Z");
    for (const action of ["build", "agent", "feedback"]) {
      const r = await writeSchedule(store, "add", `s-${action}`, { ...fields, action, body: "do it" }, ME, now);
      expect(r.ok, action).toBe(true);
    }
    const r = await writeSchedule(store, "add", "s-improve", { ...fields, action: "improve" }, ME, now);
    expect(r).toEqual({ ok: false, problem: expect.stringMatching(/improve.*setup/) });
    expect((await store.listSchedules()).map((s) => s.id)).not.toContain("s-improve");
    await store.close();
  });

  it("edit refuses changing an action to improve, and editing a stored improve schedule's action", async () => {
    const { store } = await newStore();
    const now = new Date("2026-11-22T12:00:00.000Z");
    await writeSchedule(store, "add", "s-build", { ...fields, action: "build" }, ME, now);
    const toImprove = await writeSchedule(store, "edit", "s-build", { action: "improve" }, ME, now);
    expect(toImprove).toEqual({ ok: false, problem: expect.stringMatching(/improve.*setup/) });
    expect((await store.listSchedules()).find((s) => s.id === "s-build")!.action!.kind).toBe("build");

    await addSchedule(store, { id: "improve-daily", title: "Daily improve run", cadence: { kind: "daily", spec: "09:00" }, zone: "UTC", created_by: ME, action: { kind: "improve", settings: {} } }, now);
    const body = await writeSchedule(store, "edit", "improve-daily", { body: "x" }, ME, now);
    expect(body).toEqual({ ok: false, problem: expect.stringMatching(/improve.*setup/) });
    // Other fields of the stored improve schedule still change.
    expect((await writeSchedule(store, "edit", "improve-daily", { title: "Improve" }, ME, now)).ok).toBe(true);
    await store.close();
  });
});
