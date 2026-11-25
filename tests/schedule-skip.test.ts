// The missed-time rule (design 08-schedules): a due occurrence of a `skip` schedule is recorded as `skipped` when it
// is claimed more than one tick period late (no count), or with the queued implement count while the store holds the
// threshold (default 15) or more queued implement runs; it moves `next_due_at` on, leaves `running_since` unset, and is
// never run later. A `catch_up` schedule fires once, late or busy. run_now on add makes the first due time now.

import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261123T1000-controller-schedule-skip.migration.js";
import { type AddScheduleInput, SKIP_WHEN_BUSY_THRESHOLD, addSchedule, runDueSchedules } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { type MigrationDb, tableColumns } from "../src/state/index.js";
import { issue, system } from "./helpers/store.js";

const ME = "local:owner" as UserId;
const HOUR = 3_600_000;
const TICK = 2_000;
const DAILY: AddScheduleInput = { id: "sch_feedback", title: "Feedback", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME };

async function setup() {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z"); // 21:00 Seoul: first due 2026-11-23 00:00Z
  const driver = new SqliteDriver(":memory:");
  const store = new SqlFactoryStore(driver, clock);
  await store.migrate();
  return { clock, driver, store };
}

/** Queues `n` implement runs (and one review run, which never counts). */
async function queueImplements(store: SqlFactoryStore, n: number) {
  const { item } = await store.createWorkItem(issue(1), system);
  for (let i = 0; i < n; i++) await store.enqueueRun({ work_item_id: item.id, kind: "implement", idempotency_key: `implement-${i}` });
  await store.enqueueRun({ work_item_id: item.id, kind: "review", idempotency_key: "review-0" });
}

describe("missed_rule", () => {
  it("is catch_up when unset, and the threshold defaults to 15", async () => {
    const { store } = await setup();
    const added = await addSchedule(store, DAILY, new Date("2026-11-22T12:00:00.000Z"));
    expect(added).toMatchObject({ ok: true, schedule: { missed_rule: "catch_up" } });
    expect(SKIP_WHEN_BUSY_THRESHOLD).toBe(15);
    await store.close();
  });

  it("counts only queued implement runs", async () => {
    const { store } = await setup();
    expect(await store.countQueuedImplementRuns()).toBe(0);
    await queueImplements(store, 3);
    expect(await store.countQueuedImplementRuns()).toBe(3);
    await store.close();
  });

  it("skip: at the threshold, a due occurrence is recorded as skipped with the count, and no run is queued", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, { ...DAILY, missed_rule: "skip" }, clock.now());
    await queueImplements(store, SKIP_WHEN_BUSY_THRESHOLD);
    clock.advance(12 * HOUR); // 2026-11-23 09:00 Seoul, on the slot
    const pass = await runDueSchedules(store, clock.now(), { tick_ms: TICK });
    expect(pass.fired).toEqual([]);
    expect(pass.skipped.map((r) => [r.occurrence_at, r.outcome, r.queued_implement_runs])).toEqual([["2026-11-23T00:00:00.000Z", "skipped", SKIP_WHEN_BUSY_THRESHOLD]]);
    expect(await store.countQueuedImplementRuns()).toBe(SKIP_WHEN_BUSY_THRESHOLD);
    const [s] = await store.listSchedules();
    expect(s).toMatchObject({ next_due_at: "2026-11-24T00:00:00.000Z", running_since: null });

    // Not run later: the next pass claims nothing for that slot.
    clock.advance(HOUR);
    const again = await runDueSchedules(store, clock.now(), { tick_ms: TICK });
    expect([...again.fired, ...again.skipped, ...again.refused]).toEqual([]);
    expect((await store.listScheduleRuns("sch_feedback")).map((r) => [r.occurrence_at, r.outcome, r.queued_implement_runs])).toEqual([
      ["2026-11-23T00:00:00.000Z", "skipped", SKIP_WHEN_BUSY_THRESHOLD],
    ]);
    await store.close();
  });

  it("catch_up: at the threshold, the same due occurrence fires", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    await queueImplements(store, SKIP_WHEN_BUSY_THRESHOLD);
    clock.advance(12 * HOUR);
    expect((await runDueSchedules(store, clock.now(), { tick_ms: TICK })).fired.map((r) => r.outcome)).toEqual(["fired"]);
    await store.close();
  });

  it("skip: under the threshold and on time, the due occurrence fires", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, { ...DAILY, missed_rule: "skip" }, clock.now());
    await queueImplements(store, 3);
    clock.advance(12 * HOUR + TICK); // exactly one tick late is not late
    const pass = await runDueSchedules(store, clock.now(), { tick_ms: TICK });
    expect(pass.skipped).toEqual([]);
    expect(pass.fired.map((r) => [r.occurrence_at, r.outcome])).toEqual([["2026-11-23T00:00:00.000Z", "fired"]]);
    await store.close();
  });

  it("skip: claimed more than one tick period late, the occurrence is skipped with no queued count", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, { ...DAILY, missed_rule: "skip" }, clock.now());
    clock.advance(12 * HOUR + TICK + 1);
    const pass = await runDueSchedules(store, clock.now(), { tick_ms: TICK });
    expect(pass.fired).toEqual([]);
    expect(pass.skipped).toHaveLength(1);
    expect(pass.skipped[0]).toMatchObject({ occurrence_at: "2026-11-23T00:00:00.000Z", outcome: "skipped" });
    expect(pass.skipped[0]).not.toHaveProperty("queued_implement_runs");
    expect((await store.listScheduleRuns("sch_feedback"))[0]).not.toHaveProperty("queued_implement_runs");
    expect((await store.listSchedules())[0]).toMatchObject({ next_due_at: "2026-11-24T00:00:00.000Z", running_since: null });
    await store.close();
  });

  it("catch_up: claimed days late, the missed slots fire once, as before", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, DAILY, clock.now());
    clock.advance(3 * 24 * HOUR); // three slots missed
    const pass = await runDueSchedules(store, clock.now(), { tick_ms: TICK });
    expect(pass.fired.map((r) => [r.occurrence_at, r.outcome])).toEqual([["2026-11-23T00:00:00.000Z", "fired"]]);
    expect(pass.skipped).toEqual([]);
    expect((await store.listSchedules())[0]).toMatchObject({ next_due_at: "2026-11-26T00:00:00.000Z" });
    await store.close();
  });

  it("with no tick period given, no claim is late", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, { ...DAILY, missed_rule: "skip" }, clock.now());
    clock.advance(3 * 24 * HOUR);
    expect((await runDueSchedules(store, clock.now())).fired.map((r) => r.outcome)).toEqual(["fired"]);
    await store.close();
  });

  it("a threshold given to the pass replaces the default", async () => {
    const { clock, store } = await setup();
    await addSchedule(store, { ...DAILY, missed_rule: "skip" }, clock.now());
    await queueImplements(store, 3);
    clock.advance(12 * HOUR);
    expect((await runDueSchedules(store, clock.now(), { busy_threshold: 3 })).skipped.map((r) => r.queued_implement_runs)).toEqual([3]);
    await store.close();
  });

  it("run_now on add sets next_due_at to now, and the next occurrence is the cadence's next slot after that run", async () => {
    const { clock, store } = await setup();
    const added = await addSchedule(store, { ...DAILY, missed_rule: "skip", run_now: true }, clock.now());
    expect(added).toMatchObject({ ok: true, schedule: { next_due_at: "2026-11-22T12:00:00.000Z" } });
    clock.advance(TICK);
    expect((await runDueSchedules(store, clock.now(), { tick_ms: TICK })).fired.map((r) => r.occurrence_at)).toEqual(["2026-11-22T12:00:00.000Z"]);
    expect((await store.listSchedules())[0]).toMatchObject({ next_due_at: "2026-11-23T00:00:00.000Z" });
    await store.close();
  });

  it("run_now off on add keeps the first slot after now", async () => {
    const { clock, store } = await setup();
    expect(await addSchedule(store, { ...DAILY, run_now: false }, clock.now())).toMatchObject({ ok: true, schedule: { next_due_at: "2026-11-23T00:00:00.000Z" } });
    await store.close();
  });

  it("the 20261123 migration adds both nullable columns, and running it again changes nothing", async () => {
    const { driver, store } = await setup();
    const db: MigrationDb = { dialect: "sqlite", all: (q, p) => driver.all(q, p), run: (q, p) => driver.run(q, p) };
    await migration.up(db);
    expect(await tableColumns(db, "controller_schedules")).toContain("skip_when_busy");
    expect(await tableColumns(db, "controller_schedule_runs")).toContain("queued_implement_runs");
    await store.close();
  });
});
