// The scheduler unit (design 08-schedules, phase 2): the unit claims on each controller tick at the tick's time and
// hands each fired occurrence to the selected action; with no action it claims nothing. The plugin kind itself is
// covered by tests/schedule-action-contract.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/compose.js";
import scheduleUnit, { ScheduleUnit } from "../src/controller/units/schedule/schedule.unit.js";
import type { Ctx } from "../src/controller/units/context.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { type AddScheduleInput, addSchedule } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { ScheduleAction } from "../src/interfaces/schedule-action.js";
import { loadConfig } from "../src/load-config.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { fakeRepoLookup, silent } from "./helpers/fakes/config.js";
import { fakeGitHubAccess } from "./helpers/fakes/github.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const ME = "local:owner" as UserId;
const HOUR = 3_600_000;
const DAILY: AddScheduleInput = { id: "sch_daily", title: "Morning review", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME };

afterEach(() => vi.unstubAllEnvs());

/** A fake action that records each occurrence it ran. */
function fakeAction(fail = false): ScheduleAction & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async run(schedule, occurrence_at) {
      ran.push(`${schedule.id}@${occurrence_at}`);
      if (fail) throw new Error("action failed");
    },
  };
}

async function setup(start = "2026-11-22T12:00:00.000Z") {
  const clock = new FakeClock(start);
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  return { clock, store };
}

/**
 * The unit over a kernel whose deps hold only the action, bound to `store` as compose binds it: it has no clock to
 * read, so a claim can only go by the tick's time. No action: the deps hold nothing.
 */
function unitOver(store: SqlFactoryStore, action?: ScheduleAction, log = silent): ScheduleUnit {
  const d = action ? { schedule_action: scheduledAction(store, action, log) } : {};
  return new ScheduleUnit({ k: { d } } as unknown as Ctx);
}

const tickOf = (ms: number) => tickAt("decide", 1, ms);

describe("the scheduler unit", () => {
  it("has one step on each controller tick, whose load runs the pass at the tick's time and whose decision writes nothing", async () => {
    expect(scheduleUnit.name).toBe("schedule");
    const steps = scheduleUnit.steps ?? [];
    expect(steps.map((s) => [s.name, s.every])).toEqual([["schedules", "tick"]]);
    const step = steps[0]!;
    if (!("load" in step)) throw new Error("the schedules step takes the tick through load");
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    const action = fakeAction();
    const unit = unitOver(store, action);
    const tick = tickOf(Date.parse("2026-11-23T00:00:00.000Z"));
    const loaded = await step.load(unit, {} as never, tick);
    expect(step.decide(unit, loaded, tick)).toEqual({ writes: [] });
    expect(action.ran).toEqual(["sch_daily@2026-11-23T00:00:00.000Z"]);
    await store.close();
  });

  it("with no schedules stored, a tick changes no rows and calls no action", async () => {
    const { clock, store } = await setup();
    const action = fakeAction();
    await unitOver(store, action).scheduleStep(tickOf(clock.now().getTime()));
    expect(await store.listSchedules()).toEqual([]);
    expect(action.ran).toEqual([]);
    await store.close();
  });

  it("with a due schedule and no action selected, the tick leaves the occurrence unclaimed", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    const due = Date.parse("2026-11-23T00:00:00.000Z") + HOUR;
    await unitOver(store).scheduleStep(tickOf(due));
    expect((await store.listSchedules())[0]).toMatchObject({ next_due_at: "2026-11-23T00:00:00.000Z", running_since: null });
    expect(await store.listScheduleRuns("sch_daily")).toEqual([]);
    await store.close();
  });

  it("with a fake action, a tick runs it once per fired occurrence at the tick's time, and a second tick runs nothing new", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    await addSchedule(store, { ...DAILY, id: "sch_other", title: "Other" }, clock.now());
    const action = fakeAction();
    const unit = unitOver(store, action);
    // The store's clock stays at the start: the claim goes by the tick's time alone.
    const due = Date.parse("2026-11-23T00:00:00.000Z") + HOUR;
    await unit.scheduleStep(tickOf(due));
    expect(action.ran.sort()).toEqual(["sch_daily@2026-11-23T00:00:00.000Z", "sch_other@2026-11-23T00:00:00.000Z"]);
    expect((await store.listScheduleRuns("sch_daily")).map((r) => [r.occurrence_at, r.outcome])).toEqual([["2026-11-23T00:00:00.000Z", "fired"]]);
    // The run ended: the schedule is idle again, and due next at the following slot.
    expect((await store.listSchedules()).map((s) => s.running_since)).toEqual([null, null]);

    await unit.scheduleStep(tickOf(due));
    await unit.scheduleStep(tickOf(due + HOUR));
    expect(action.ran).toHaveLength(2);
    expect((await store.listSchedules()).map((s) => s.next_due_at)).toEqual(["2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z"]);
    await store.close();
  });

  it("a failed action is logged and still ends the run, so the next occurrence fires", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    const warned: string[] = [];
    const log = { ...silent, warn: (msg: string) => void warned.push(msg) };
    const action = fakeAction(true);
    const unit = unitOver(store, action, log);
    await unit.scheduleStep(tickOf(Date.parse("2026-11-23T00:00:00.000Z")));
    expect(warned).toEqual(["schedule action failed"]);
    expect((await store.listSchedules())[0]!.running_since).toBeNull();
    await unit.scheduleStep(tickOf(Date.parse("2026-11-24T00:00:00.000Z")));
    expect(action.ran).toEqual(["sch_daily@2026-11-23T00:00:00.000Z", "sch_daily@2026-11-24T00:00:00.000Z"]);
    await store.close();
  });
});

/** A solo-config repo root: the local source and broker, a fake GitHub credential plugin. */
function soloRoot(plugins: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-schedule-start-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const solo = { ...(REAL.plugins as object), awake: "none", updater: "none", source: ["local"], broker: "local", github_auth: "recording", ...plugins };
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, plugins: solo, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" }));
  writeFileSync(join(dir, "secrets.env"), "MYSQL_PASSWORD=pw\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
  return dir;
}

describe("build() with the schedule_action kind", () => {
  const base: Registry = withPlugin(REGISTRY, "github_auth", "recording", () => fakeGitHubAccess({ token: async () => null }));

  it("with no schedules and no action configured, build() succeeds and the factory starts as before", async () => {
    const loaded = await loadConfig(soloRoot(), { registry: base });
    expect(loaded.plugins.schedule_action).toBeUndefined();
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    expect(await built.store.listSchedules()).toEqual([]);
    await (await built.controller.unit("schedule")).scheduleStep(tickOf(Date.parse("2026-11-23T00:00:00.000Z")));
    await built.close();
  });

  it("a selected action is built once and reaches the scheduler unit", async () => {
    const action = fakeAction();
    let made = 0;
    const registry = withPlugin(base, "schedule_action", "fake", () => (made++, action));
    const loaded = await loadConfig(soloRoot({ schedule_action: "fake" }), { registry });
    const clock = new FakeClock("2026-11-22T12:00:00.000Z");
    const built = await build(loaded, { clock, repoLookup: fakeRepoLookup });
    expect(made).toBe(1);
    await addSchedule(built.store, DAILY, clock.now());
    await (await built.controller.unit("schedule")).scheduleStep(tickOf(Date.parse("2026-11-23T00:00:00.000Z")));
    expect(action.ran).toEqual(["sch_daily@2026-11-23T00:00:00.000Z"]);
    await built.close();
  });
});
