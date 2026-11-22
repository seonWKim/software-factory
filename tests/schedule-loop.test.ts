// Schedules (design 08-schedules) over the SQLite store: each due occurrence is claimed once by one conditional
// update, missed slots make one occurrence, a running schedule's due occurrence is refused and recorded, and a
// schedule is its own record, never a plain task's repeat.

import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261122T1000-controller-schedules.migration.js";
import { type AddScheduleInput, type ScheduleStore, addSchedule, runDueSchedules } from "../src/core/schedule.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { MigrationDb } from "../src/state/index.js";

const ME = "local:owner" as UserId;
const HOUR = 3_600_000;
const DAILY: AddScheduleInput = { id: "sch_daily", title: "Morning review", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME };

async function setup(start = "2026-11-22T12:00:00.000Z") {
  const clock = new FakeClock(start);
  const driver = new SqliteDriver(":memory:");
  const store = new SqlFactoryStore(driver, clock);
  await store.migrate();
  return { clock, driver, store };
}

describe("schedule store", () => {
  it("the migration adds both tables, and running it again changes nothing", async () => {
    const { driver, store } = await setup();
    const db: MigrationDb = { dialect: "sqlite", all: (q, p) => driver.all(q, p), run: (q, p) => driver.run(q, p) };
    await migration.up(db);
    const names = (await store.listTables()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["controller_schedules", "controller_schedule_runs"]));
    await store.close();
  });

  it("a repeating task creates no schedule record", async () => {
    const { store } = await setup();
    await store.addTask({ id: "tk_rent", title: "Pay rent", list: null, priority: null, due: { date: "2026-12-01" }, due_time: null, recurrence: "month", created_by: ME });
    expect(await store.listSchedules()).toEqual([]);
    await store.close();
  });
});

describe("runDueSchedules", () => {
  it("a daily 09:00 fires once per local day; a restart or a missed day makes no duplicate", async () => {
    // 21:00 Seoul on 2026-11-22: first due 2026-11-23 09:00 Seoul (00:00Z).
    const { clock, store } = await setup();
    const added = await addSchedule(store, DAILY, clock.now());
    expect(added).toMatchObject({ ok: true, schedule: { next_due_at: "2026-11-23T00:00:00.000Z" } });

    clock.advance(12 * HOUR); // 2026-11-23 09:00 Seoul
    const { fired } = await runDueSchedules(store, clock.now());
    expect(fired.map((r) => r.occurrence_at)).toEqual(["2026-11-23T00:00:00.000Z"]);
    await store.endScheduleRun("sch_daily", fired[0]!.recorded_at);
    clock.advance(HOUR); // a restart later the same morning
    expect((await runDueSchedules(store, clock.now())).fired).toEqual([]);

    clock.advance(48 * HOUR); // down through 2026-11-24; back at 2026-11-25 10:00 Seoul
    expect((await runDueSchedules(store, clock.now())).fired.map((r) => r.occurrence_at)).toEqual(["2026-11-24T00:00:00.000Z"]);
    expect((await store.listSchedules())[0]!.next_due_at).toBe("2026-11-26T00:00:00.000Z");
    expect(await store.listScheduleRuns("sch_daily")).toHaveLength(2);
    await store.close();
  });

  it("slots missed while down run once on return, against the slot that was due", async () => {
    const { clock, store } = await setup("2026-11-22T00:00:00.000Z");
    await addSchedule(store, { ...DAILY, id: "sch_hourly", cadence: { kind: "interval", spec: "60" }, zone: "UTC" }, clock.now());
    clock.advance(5 * HOUR + 30 * 60_000);
    const { fired } = await runDueSchedules(store, clock.now());
    expect(fired).toEqual([{ schedule_id: "sch_hourly", occurrence_at: "2026-11-22T01:00:00.000Z", outcome: "fired", recorded_at: "2026-11-22T05:30:00.000Z" }]);
    expect((await store.listSchedules())[0]!.next_due_at).toBe("2026-11-22T06:00:00.000Z");
    await store.close();
  });

  it("two workers that read the same due occurrence fire it once; the loser fires nothing", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    clock.advance(12 * HOUR);
    const stale = await store.listDueSchedules(clock.now().toISOString() as Timestamp);
    // Worker B read the due list before worker A claimed: it sees the old next_due_at.
    const workerB: ScheduleStore = Object.assign(Object.create(store) as ScheduleStore, { listDueSchedules: async () => stale });
    const a = await runDueSchedules(store, clock.now());
    const b = await runDueSchedules(workerB, clock.now());
    expect([a.fired.length, b.fired.length, b.refused.length]).toEqual([1, 0, 0]);
    expect(await store.listScheduleRuns("sch_daily")).toHaveLength(1);
    await store.close();
  });

  it("a due occurrence of a running schedule is refused and stored as a run row; once ended, the next fires", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    clock.advance(12 * HOUR);
    const [first] = (await runDueSchedules(store, clock.now())).fired;
    clock.advance(24 * HOUR); // still running a day later
    const { fired, refused } = await runDueSchedules(store, clock.now());
    expect(fired).toEqual([]);
    expect(refused.map((r) => [r.occurrence_at, r.outcome])).toEqual([["2026-11-24T00:00:00.000Z", "refused"]]);
    expect((await store.listScheduleRuns("sch_daily")).map((r) => r.outcome)).toEqual(["fired", "refused"]);

    expect(await store.endScheduleRun("sch_daily", first!.recorded_at)).toBe(true);
    clock.advance(24 * HOUR);
    expect((await runDueSchedules(store, clock.now())).fired.map((r) => r.occurrence_at)).toEqual(["2026-11-25T00:00:00.000Z"]);
    await store.close();
  });

  it("refuses a schedule whose cadence or zone is wrong, storing nothing", async () => {
    const { clock, store } = await setup();
    expect(await addSchedule(store, { ...DAILY, zone: "Nowhere/City" }, clock.now())).toMatchObject({ ok: false, problem: expect.stringMatching(/time zone/) });
    expect(await store.listSchedules()).toEqual([]);
    await store.close();
  });
});
