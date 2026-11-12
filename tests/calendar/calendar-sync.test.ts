import { describe, expect, it } from "vitest";
import { CALENDAR_SYNC_MS, syncCalendars } from "../../src/calendar/index.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import type { CalendarSource } from "../../src/interfaces/calendar-source.js";
import type { SqlDriver } from "../../src/state/index.js";
import { FakeAuth, FakeSource, cleanScanner, config, silent } from "../helpers/fakes.js";
import { newStore } from "../helpers/store.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";

// The calendar component and its controller unit (design 02-tasks, calendar): each configured source syncs at most
// once per 5 minutes, its due time stored in calendar_sync_state, so every replica sees one schedule. Fake sources only.

const MINUTE = 60_000;

async function harness(calendar: { name: string; source: CalendarSource }[]) {
  const { store, clock } = await newStore();
  const db = (store as unknown as { db: SqlDriver }).db;
  const role = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, calendar });
  const step = async () => (await role.unit("calendar")).calendarStep();
  const rows = async (table: "calendar_events" | "calendar_sync_state") => db.all(`SELECT * FROM ${table} ORDER BY source`);
  return { store, clock, db, step, rows };
}

describe("calendar sync", () => {
  it("with no source configured, a tick reads no calendar data and writes no calendar row", async () => {
    const { db, step, rows } = await harness([]);
    const reads: string[] = [];
    const all = db.all.bind(db);
    db.all = async (sql, params) => {
      reads.push(sql);
      return all(sql, params);
    };
    await step();
    expect(reads.filter((s) => s.includes("calendar_"))).toEqual([]);
    db.all = all;
    expect(await rows("calendar_events")).toEqual([]);
    expect(await rows("calendar_sync_state")).toEqual([]);
  });

  it("syncs a fake source into both tables, keyed by source name, at most once per 5 minutes (FakeClock)", async () => {
    const work = new FakeCalendarSource([calendarEvent("a"), calendarEvent("b", { all_day: true, updated_at: "2026-01-01T00:00:00.000Z" })]);
    const home = new FakeCalendarSource([calendarEvent("a", { title: "dentist" })]);
    const { clock, step, rows } = await harness([{ name: "work", source: work }, { name: "home", source: home }]);
    const t0 = clock.now().getTime();

    await step();
    expect(work.windows).toHaveLength(1);
    expect(home.windows).toHaveLength(1);
    expect((await rows("calendar_events")).map((r) => [r.source, r.event_id, r.title, r.all_day])).toEqual([
      ["home", "a", "dentist", 0],
      ["work", "a", "event a", 0],
      ["work", "b", "event b", 1],
    ]);
    const state = await rows("calendar_sync_state");
    expect(state.map((r) => [r.source, r.next_sync_at, r.synced_at, r.error])).toEqual([
      ["home", new Date(t0 + CALENDAR_SYNC_MS).toISOString(), new Date(t0).toISOString(), null],
      ["work", new Date(t0 + CALENDAR_SYNC_MS).toISOString(), new Date(t0).toISOString(), null],
    ]);
    expect(CALENDAR_SYNC_MS).toBe(5 * MINUTE);

    // Before the stored due time: no call, whatever the number of ticks.
    clock.advance(4 * MINUTE + 59_000);
    await step();
    await step();
    expect(work.windows).toHaveLength(1);

    // At the due time: one more sync, which replaces the source's events with what it answers now.
    clock.advance(1_000);
    work.list = [calendarEvent("c")];
    await step();
    await step();
    expect(work.windows).toHaveLength(2);
    expect(home.windows).toHaveLength(2);
    expect((await rows("calendar_events")).filter((r) => r.source === "work").map((r) => r.event_id)).toEqual(["c"]);
  });

  it("the stored due time holds across replicas: a second controller on the same store does not sync again", async () => {
    const first = new FakeCalendarSource([calendarEvent("a")]);
    const second = new FakeCalendarSource([calendarEvent("a")]);
    const { store, clock, step } = await harness([{ name: "work", source: first }]);
    await step();
    const other = new ControllerRole({
      store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, calendar: [{ name: "work", source: second }],
    });
    await (await other.unit("calendar")).calendarStep();
    expect(second.windows).toEqual([]);
    clock.advance(CALENDAR_SYNC_MS);
    await (await other.unit("calendar")).calendarStep();
    await step();
    expect(second.windows).toHaveLength(1);
    expect(first.windows).toHaveLength(1);
  });

  it("a failing source records its error in calendar_sync_state, keeps its stored events and does not stop the others", async () => {
    const flaky = new FakeCalendarSource([calendarEvent("a")]);
    const ok = new FakeCalendarSource([calendarEvent("z")]);
    const { clock, step, rows } = await harness([{ name: "flaky", source: flaky }, { name: "ok", source: ok }]);
    await step();
    flaky.failWith = "calendar provider unreachable";
    clock.advance(CALENDAR_SYNC_MS);
    await step();
    const state = new Map((await rows("calendar_sync_state")).map((r) => [r.source, r]));
    expect(state.get("flaky")).toMatchObject({ error: "calendar provider unreachable", error_at: clock.now().toISOString() });
    expect(state.get("ok")).toMatchObject({ error: null, synced_at: clock.now().toISOString() });
    expect((await rows("calendar_events")).map((r) => `${r.source}/${r.event_id}`)).toEqual(["flaky/a", "ok/z"]);
    // The next try waits for the next due time too, and a success clears the error.
    flaky.failWith = null;
    clock.advance(CALENDAR_SYNC_MS);
    await step();
    expect((await rows("calendar_sync_state")).find((r) => r.source === "flaky")).toMatchObject({ error: null, error_at: null });
  });

  it("a source that fails from its first sync stores its state row with the error and no events", async () => {
    const down = new FakeCalendarSource();
    down.failWith = "boom";
    const { db, clock } = await harness([]);
    const out = await syncCalendars(db, [{ name: "down", source: down }], clock.now().getTime());
    expect(out).toEqual([{ source: "down", ok: false, error: "boom" }]);
    expect(await db.all("SELECT source, error, synced_at FROM calendar_sync_state")).toEqual([{ source: "down", error: "boom", synced_at: null }]);
    expect(await db.all("SELECT * FROM calendar_events")).toEqual([]);
    expect(await syncCalendars(db, [{ name: "down", source: down }], clock.now().getTime())).toEqual([]);
    expect(down.windows).toHaveLength(1);
  });
});
