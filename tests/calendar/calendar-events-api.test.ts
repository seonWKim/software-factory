import { describe, expect, it } from "vitest";
import { CALENDAR_SYNC_MS } from "../../src/calendar/index.js";
import { syncWindow } from "../../src/calendar/calendar-sync.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { CalendarSource } from "../../src/interfaces/calendar-source.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import type { SqlDriver } from "../../src/state/index.js";
import { CALENDAR_EVENTS_PATH, MAX_SPAN_DAYS } from "../../src/ui/calendar-events-api.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { type ApiDeps, respond } from "../../src/ui/server.js";
import { FakeAuth } from "../helpers/fakes/runner.js";
import { FakeSource } from "../helpers/fakes/source.js";
import { cleanScanner, config, silent } from "../helpers/fakes/config.js";
import { newStore } from "../helpers/store.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";

// GET /api/v1/calendar/events (design 09-dashboard-app, Calendar page): the stored events of each local day from
// `from` through `to`, a synced flag per day from each source's last successful sync window, and the sources' sync
// state of each connected source (the live `calendar` setting). Every time is built in the process's own time zone, so
// the tests hold in any zone. Fake sources only.

/** A local wall-clock instant on 2026-<month>-<day>, as ISO. */
const at = (month: number, day: number, h = 0, m = 0) => new Date(2026, month - 1, day, h, m).toISOString();
const NOW = new Date(2026, 10, 12, 9, 0);

/** `connected`: the live `calendar` setting, stored as an override as Settings' connect writes it; default every source. */
async function harness(calendar: { name: string; source: CalendarSource }[], connected = calendar.map((c) => c.name)) {
  const clock = new FakeClock(NOW);
  const { store } = await newStore(clock);
  const connect = (names: string[]) => store.setSettingOverride({ key: "calendar", project: "", value: JSON.stringify(names), actor: "owner@example.com" });
  await connect(connected);
  const db = (store as unknown as { db: SqlDriver }).db;
  const role = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, calendar });
  const sync = async () => (await role.unit("calendar")).calendarStep();
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
  };
  const get = async (query: string) => {
    const r = await respond(d, { method: "GET", url: `${CALENDAR_EVENTS_PATH}${query}`, host: "127.0.0.1:4310" });
    return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  return { clock, db, sync, get, connect };
}

interface Day {
  date: string;
  synced: boolean;
  events: { source: string; id: string; time: string | null; all_day: boolean; title: string }[];
}

const events = [
  calendarEvent("lunch", { starts_at: at(11, 13, 12), ends_at: at(11, 13, 13) }),
  calendarEvent("holiday", { starts_at: at(11, 13), ends_at: at(11, 14), all_day: true }),
  calendarEvent("standup", { starts_at: at(11, 13, 9, 30), ends_at: at(11, 13, 9, 45) }),
  calendarEvent("overnight", { starts_at: at(11, 14, 22), ends_at: at(11, 15, 2) }),
];

describe("GET /api/v1/calendar/events", () => {
  it("refuses with 400 and a reason a from or to that is not a YYYY-MM-DD date, from later than to, or a span over 62 days", async () => {
    const { get } = await harness([]);
    const cases: [string, RegExp][] = [
      ["", /from must be a date as YYYY-MM-DD/],
      ["?from=2026-11-09", /to must be a date as YYYY-MM-DD/],
      ["?from=2026-11-9&to=2026-11-15", /from must be a date/],
      ["?from=2026-02-30&to=2026-03-01", /from must be a date/],
      ["?from=2026-11-09&to=tomorrow", /to must be a date/],
      ["?from=2026-11-15&to=2026-11-09", /from must not be later than to/],
      ["?from=2026-11-01&to=2027-01-02", new RegExp(`at most ${MAX_SPAN_DAYS} days`)],
    ];
    for (const [query, reason] of cases) {
      const r = await get(query);
      expect(r.status, query).toBe(400);
      expect(String(r.body.error), query).toMatch(reason);
    }
    expect((await get("?from=2026-11-01&to=2027-01-01")).status).toBe(200);
  });

  it("answers each day from `from` through `to` with the events that overlap it, all-day first, then timed by time", async () => {
    const { sync, get } = await harness([{ name: "work", source: new FakeCalendarSource(events) }]);
    await sync();
    const r = await get("?from=2026-11-12&to=2026-11-15");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ from: "2026-11-12", to: "2026-11-15" });
    const days = r.body.days as Day[];
    expect(days.map((d) => d.date)).toEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(days.map((d) => d.events.map((e) => [e.id, e.time]))).toEqual([
      [],
      [["holiday", null], ["standup", "09:30"], ["lunch", "12:00"]],
      [["overnight", "22:00"]],
      [["overnight", "00:00"]],
    ]);
    expect(days[1]!.events[0]).toMatchObject({ kind: "event", source: "work", title: "event holiday", all_day: true });
    expect(r.body.calendar).toEqual([{ source: "work", synced_at: NOW.toISOString(), failed: false }]);
  });

  it("a day is synced only inside the window of every source's last successful sync, the window the sync asks for", async () => {
    const work = new FakeCalendarSource(events);
    const { sync, get } = await harness([{ name: "work", source: work }]);
    await sync();
    expect(work.windows).toEqual([syncWindow(NOW.getTime())]);
    // The window runs from 2026-11-11 09:00 to 2026-12-12 09:00: the 11th and the 12th of December are cut, so not synced.
    const days = (await get("?from=2026-11-10&to=2026-12-13")).body.days as Day[];
    const flags = Object.fromEntries(days.map((d) => [d.date, d.synced]));
    expect([flags["2026-11-10"], flags["2026-11-11"], flags["2026-11-12"], flags["2026-12-11"], flags["2026-12-12"]]).toEqual([false, false, true, true, false]);
    expect(days.filter((d) => d.synced).map((d) => d.date)).toEqual(days.map((d) => d.date).filter((d) => d >= "2026-11-12" && d <= "2026-12-11"));
  });

  it("a source never synced makes every day not synced", async () => {
    const broken = new FakeCalendarSource();
    broken.failWith = "down";
    const { sync, get } = await harness([{ name: "work", source: new FakeCalendarSource(events) }, { name: "home", source: broken }]);
    await sync();
    const r = await get("?from=2026-11-12&to=2026-11-15");
    expect((r.body.days as Day[]).map((d) => d.synced)).toEqual([false, false, false, false]);
    expect(r.body.calendar).toEqual([{ source: "home", synced_at: null, failed: true }, { source: "work", synced_at: NOW.toISOString(), failed: false }]);
  });

  it("with no source listed, no day is synced", async () => {
    const { get } = await harness([]);
    const r = await get("?from=2026-11-12&to=2026-11-12");
    expect(r.body).toMatchObject({ days: [{ date: "2026-11-12", synced: false, events: [] }], calendar: [] });
  });

  it("a source whose last sync failed keeps its stored events and the synced days of its last success", async () => {
    const work = new FakeCalendarSource(events);
    const { clock, sync, get } = await harness([{ name: "work", source: work }]);
    await sync();
    work.failWith = "down";
    clock.advance(CALENDAR_SYNC_MS);
    await sync();
    const r = await get("?from=2026-11-13&to=2026-11-13");
    expect(r.body.calendar).toEqual([{ source: "work", synced_at: NOW.toISOString(), failed: true }]);
    expect(r.body.days).toMatchObject([{ date: "2026-11-13", synced: true, events: [{ id: "holiday" }, { id: "standup" }, { id: "lunch" }] }]);
  });

  it("a valid read calls no calendar source and writes nothing", async () => {
    const work = new FakeCalendarSource(events);
    const { db, sync, get } = await harness([{ name: "work", source: work }]);
    await sync();
    const tables = async () => JSON.stringify([await db.all("SELECT * FROM calendar_events ORDER BY event_id"), await db.all("SELECT * FROM calendar_sync_state")]);
    const before = await tables();
    const writes: string[] = [];
    const run = db.run.bind(db);
    db.run = async (sql, params) => {
      writes.push(sql);
      return run(sql, params);
    };
    expect((await get("?from=2026-11-09&to=2026-11-15")).status).toBe(200);
    expect((await get("?from=2026-11-01&to=2026-11-30")).status).toBe(200);
    db.run = run;
    expect(work.windows).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(await tables()).toBe(before);
  });

  it("lists a connected source that has no sync row yet with synced_at null, so its days are not synced", async () => {
    const { db, get } = await harness([], ["google-calendar"]);
    expect(await db.all("SELECT * FROM calendar_sync_state")).toEqual([]);
    const r = await get("?from=2026-11-12&to=2026-11-13");
    expect(r.body.calendar).toEqual([{ source: "google-calendar", synced_at: null, failed: false }]);
    expect((r.body.days as Day[]).map((d) => d.synced)).toEqual([false, false]);
  });

  it("leaves out a disconnected source with old sync rows, and its stored events", async () => {
    const { sync, get, connect } = await harness([{ name: "work", source: new FakeCalendarSource(events) }, { name: "home", source: new FakeCalendarSource([calendarEvent("gym", { starts_at: at(11, 13, 7), ends_at: at(11, 13, 8) })]) }]);
    await sync();
    const before = await get("?from=2026-11-13&to=2026-11-13");
    expect((before.body.days as Day[])[0]!.events.map((e) => e.source)).toContain("home");
    await connect(["work"]);
    const r = await get("?from=2026-11-13&to=2026-11-13");
    expect(r.body.calendar).toEqual([{ source: "work", synced_at: NOW.toISOString(), failed: false }]);
    expect(r.body.days).toMatchObject([{ date: "2026-11-13", synced: true, events: [{ id: "holiday" }, { id: "standup" }, { id: "lunch" }] }]);
    expect((r.body.days as Day[])[0]!.events.map((e) => e.source)).not.toContain("home");
  });

  it("with no source connected, stored events and sync rows are not shown", async () => {
    const { sync, get, connect } = await harness([{ name: "work", source: new FakeCalendarSource(events) }]);
    await sync();
    await connect([]);
    const r = await get("?from=2026-11-13&to=2026-11-13");
    expect(r.body).toMatchObject({ calendar: [], days: [{ date: "2026-11-13", synced: false, events: [] }] });
  });
});
