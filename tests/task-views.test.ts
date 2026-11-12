import { describe, expect, it } from "vitest";
import { type CalendarFeed, type FeedEvent, syncCalendars } from "../src/calendar/index.js";
import { type DayEntry, type NewTask, taskViews } from "../src/core/tasks.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { TASKS_PATH } from "../src/ui/tasks-api.js";
import { newStore } from "./helpers/store.js";

// The Tasks page's views (design 02-tasks, issue #607, calendar views): Inbox, Today (overdue first), Upcoming (today
// through 7 days ahead, by day) and Projects, each task placed by its due date against the injected Clock's local calendar date, so the day ends at
// local midnight. Every time below is built in the process's own time zone, so the tests hold in any zone.

const USER = "local:dev@example.com" as UserId;
/** A local wall-clock time on 2026-11-<day>. */
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m);

const task = (id: string, over: Partial<NewTask> = {}): NewTask => ({
  id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: USER, ...over,
});

async function setup(now: Date) {
  const clock = new FakeClock(now);
  const { store } = await newStore(clock);
  const views = async () => taskViews(await store.listTasks(100), clock.now());
  return { store, clock, views };
}

const ids = (ts: readonly DayEntry[]) => ts.map((t) => t.id);

describe("task views: the day boundary at local midnight (injected Clock)", () => {
  it("a task due on the 12th, due at 23:59 or at 00:00, is Today until 23:59 and overdue from 00:00 on the 13th", async () => {
    const s = await setup(at(12, 9, 0));
    await s.store.addTask(task("late", { due: { date: "2026-11-12" }, due_time: "23:59" }));
    await s.store.addTask(task("early", { due: { date: "2026-11-12" }, due_time: "00:00" }));
    s.clock.advance(at(12, 23, 59).getTime() - s.clock.now().getTime());
    let v = await s.views();
    expect(v.today_date).toBe("2026-11-12");
    expect(ids(v.today.due)).toEqual(["early", "late"]);
    expect(v.today.overdue).toEqual([]);
    s.clock.advance(60_000); // 00:00 on the 13th
    v = await s.views();
    expect(v.today_date).toBe("2026-11-13");
    expect(ids(v.today.overdue)).toEqual(["early", "late"]);
    expect(v.today.due).toEqual([]);
  });

  it("a task due on the 13th is Upcoming at 23:59 on the 12th, and Today and Upcoming's first day at 00:00 on the 13th", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask(task("t", { due: { date: "2026-11-13" } }));
    let v = await s.views();
    expect(v.upcoming).toEqual([{ date: "2026-11-13", tasks: [expect.objectContaining({ id: "t" })] }]);
    expect(v.today.due).toEqual([]);
    s.clock.advance(60_000);
    v = await s.views();
    expect(v.upcoming).toEqual([{ date: "2026-11-13", tasks: [expect.objectContaining({ id: "t" })] }]);
    expect(ids(v.today.due)).toEqual(["t"]);
  });

  it("Upcoming ends 7 days after today: a task due 8 days out joins it only at the next local midnight", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask(task("week", { due: { date: "2026-11-19" } }));
    await s.store.addTask(task("eight", { due: { date: "2026-11-20" } }));
    expect((await s.views()).upcoming.map((d) => d.date)).toEqual(["2026-11-19"]);
    s.clock.advance(60_000);
    expect((await s.views()).upcoming.map((d) => d.date)).toEqual(["2026-11-19", "2026-11-20"]);
  });

  it("today and tomorrow typed at 23:59 resolve against the Clock, and land in Today and Upcoming", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask({ ...task("a"), due: { days_from_today: 0 } });
    await s.store.addTask({ ...task("b"), due: { days_from_today: 1 } });
    const v = await s.views();
    expect(ids(v.today.due)).toEqual(["a"]);
    expect(v.upcoming.map((d) => [d.date, ids(d.tasks)])).toEqual([["2026-11-12", ["a"]], ["2026-11-13", ["b"]]]);
  });
});

describe("task views: placement", () => {
  it("Inbox holds the open tasks with no due date; Today lists overdue first, oldest due first, then today's", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("undated"));
    await s.store.addTask(task("today", { due: { date: "2026-11-12" } }));
    await s.store.addTask(task("yesterday", { due: { date: "2026-11-11" } }));
    await s.store.addTask(task("last-week", { due: { date: "2026-11-05" } }));
    await s.store.addTask(task("done", { due: { date: "2026-11-01" } }));
    await s.store.completeTask("done");
    const v = await s.views();
    expect(ids(v.inbox)).toEqual(["undated"]);
    expect(ids(v.today.overdue)).toEqual(["last-week", "yesterday"]);
    expect(ids(v.today.due)).toEqual(["today"]);
  });

  it("Upcoming groups today through 7 days ahead by day, in date order, with only the days that have a task", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("c", { due: { date: "2026-11-15" } }));
    await s.store.addTask(task("a", { due: { date: "2026-11-13" }, due_time: "18:00" }));
    await s.store.addTask(task("b", { due: { date: "2026-11-13" }, due_time: "08:00" }));
    await s.store.addTask(task("today", { due: { date: "2026-11-12" } }));
    const v = await s.views();
    expect(v.upcoming.map((d) => [d.date, ids(d.tasks)])).toEqual([["2026-11-12", ["today"]], ["2026-11-13", ["b", "a"]], ["2026-11-15", ["c"]]]);
  });

  it("Projects places every open task under its list by due date, undated last, and unlabelled tasks last", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("home-undated", { list: "home" }));
    await s.store.addTask(task("home-later", { list: "home", due: { date: "2026-12-01" } }));
    await s.store.addTask(task("home-overdue", { list: "home", due: { date: "2026-11-01" } }));
    await s.store.addTask(task("bank", { list: "bank", due: { date: "2026-11-20" } }));
    await s.store.addTask(task("none"));
    const v = await s.views();
    expect(v.projects.map((p) => [p.list, ids(p.tasks)])).toEqual([
      ["bank", ["bank"]],
      ["home", ["home-overdue", "home-later", "home-undated"]],
      [null, ["none"]],
    ]);
  });
});

// Calendar events beside the tasks (design 02-tasks, calendar views): GET /api/v1/tasks places the events the last
// syncs stored (src/calendar/) in Today and Upcoming. A page request reads the stored copy only.

/** A local wall-clock instant on 2026-11-<day>, as the ISO string a source answers. */
const iso = (day: number, h = 0, m = 0) => at(day, h, m).toISOString();
const event = (id: string, starts: string, ends: string, all_day = false): FeedEvent => ({ id, title: id, starts_at: starts, ends_at: ends, all_day, updated_at: null });

/** A fake source that answers `events`, or throws while `fail` is set; counts its reads. */
function feed(events: FeedEvent[]) {
  const f = { calls: 0, fail: false, events: (async () => {
    f.calls++;
    if (f.fail) throw new Error("source is down");
    return events;
  }) as CalendarFeed["events"] };
  return f;
}

async function page(now: Date) {
  const s = await setup(now);
  const d: ApiDeps = {
    store: s.store, scanner: new PatternEgressScanner(async () => []), clock: s.clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], s.clock),
  };
  const get = async () => JSON.parse((await respond(d, { method: "GET", url: TASKS_PATH, host: "127.0.0.1:4310" })).body);
  /** Every calendar row, to show a page request wrote none. */
  const rows = async () => [await s.store.db.all("SELECT * FROM calendar_events ORDER BY source, event_id"), await s.store.db.all("SELECT * FROM calendar_sync_state ORDER BY source")];
  const sync = (feeds: { name: string; source: CalendarFeed }[]) => syncCalendars(s.store.db, feeds, s.clock.now().getTime());
  return { ...s, get, rows, sync };
}

const entries = (es: { id: string; kind?: string }[]) => es.map((e) => (e.kind === "event" ? `event:${e.id}` : e.id));

describe("task views: calendar events in Today and Upcoming", () => {
  it("Today: all-day events first, then timed tasks and events by time, then the untimed tasks in their order", async () => {
    const s = await page(at(12, 8, 0));
    await s.store.addTask(task("untimed-old", { due: { date: "2026-11-12" } }));
    await s.store.addTask(task("untimed-p1", { due: { date: "2026-11-12" }, priority: 1 }));
    await s.store.addTask(task("call", { due: { date: "2026-11-12" }, due_time: "11:00" }));
    await s.store.addTask(task("late", { due: { date: "2026-11-11" } }));
    const cal = feed([
      event("standup", iso(12, 9, 30), iso(12, 10, 0)),
      event("holiday", iso(12), iso(13), true),
      event("lunch", iso(12, 12, 0), iso(12, 13, 0)),
      event("tomorrow", iso(13, 9, 0), iso(13, 10, 0)),
    ]);
    await s.sync([{ name: "work", source: { events: cal.events } }]);
    const v = await s.get();
    expect(entries(v.today.overdue)).toEqual(["late"]);
    expect(entries(v.today.due)).toEqual(["event:holiday", "event:standup", "call", "event:lunch", "untimed-p1", "untimed-old"]);
    expect(v.today.due[0]).toMatchObject({ kind: "event", source: "work", title: "holiday", all_day: true, time: null });
    expect(v.today.due[1]).toMatchObject({ kind: "event", time: "09:30" });
  });

  it("Upcoming: tasks and events from today through 7 days ahead, grouped by day", async () => {
    const s = await page(at(12, 8, 0));
    await s.store.addTask(task("now", { due: { date: "2026-11-12" } }));
    await s.store.addTask(task("soon", { due: { date: "2026-11-14" }, due_time: "10:00" }));
    await s.store.addTask(task("far", { due: { date: "2026-11-20" } }));
    const cal = feed([
      event("past", iso(11, 9, 0), iso(11, 10, 0)),
      event("dentist", iso(12, 15, 0), iso(12, 16, 0)),
      event("trip", iso(14), iso(16), true),
      event("week", iso(19, 9, 0), iso(19, 10, 0)),
      event("eight", iso(20, 9, 0), iso(20, 10, 0)),
    ]);
    await s.sync([{ name: "work", source: { events: cal.events } }]);
    const v = await s.get();
    expect(v.upcoming.map((d: { date: string; tasks: { id: string; kind?: string }[] }) => [d.date, entries(d.tasks)])).toEqual([
      ["2026-11-12", ["event:dentist", "now"]],
      ["2026-11-14", ["event:trip", "soon"]],
      ["2026-11-15", ["event:trip"]],
      ["2026-11-19", ["event:week"]],
    ]);
  });

  it("when the last sync failed, Today and Upcoming show the last stored events and the last sync time", async () => {
    const s = await page(at(12, 8, 0));
    const cal = feed([event("standup", iso(12, 9, 30), iso(12, 10, 0)), event("review", iso(13, 14, 0), iso(13, 15, 0))]);
    await s.sync([{ name: "work", source: { events: cal.events } }]);
    const synced = s.clock.now().toISOString();
    s.clock.advance(10 * 60_000);
    cal.fail = true;
    expect(await s.sync([{ name: "work", source: { events: cal.events } }])).toEqual([{ source: "work", ok: false, error: "source is down" }]);
    const v = await s.get();
    expect(v.calendar).toEqual([{ source: "work", synced_at: synced, failed: true }]);
    expect(entries(v.today.due)).toEqual(["event:standup"]);
    expect(v.upcoming.map((d: { date: string; tasks: { id: string; kind?: string }[] }) => [d.date, entries(d.tasks)])).toEqual([
      ["2026-11-12", ["event:standup"]],
      ["2026-11-13", ["event:review"]],
    ]);
  });

  it("a second source, added here, shows its events in Today beside the first's", async () => {
    const s = await page(at(12, 8, 0));
    const work = feed([event("standup", iso(12, 9, 30), iso(12, 10, 0))]);
    const home = feed([event("standup", iso(12, 18, 0), iso(12, 19, 0)), event("birthday", iso(12), iso(13), true)]);
    await s.sync([{ name: "work", source: { events: work.events } }, { name: "home", source: { events: home.events } }]);
    const v = await s.get();
    expect(v.today.due.map((e: { source: string; id: string }) => `${e.source}:${e.id}`)).toEqual(["home:birthday", "work:standup", "home:standup"]);
    expect(v.calendar).toEqual([{ source: "home", synced_at: expect.any(String), failed: false }, { source: "work", synced_at: expect.any(String), failed: false }]);
  });

  it("with no calendar source configured: no events, no source state and no error", async () => {
    const s = await page(at(12, 8, 0));
    await s.store.addTask(task("now", { due: { date: "2026-11-12" } }));
    expect(await s.sync([])).toEqual([]);
    const v = await s.get();
    expect(v.calendar).toEqual([]);
    expect(entries(v.today.due)).toEqual(["now"]);
    expect(v.upcoming.map((d: { date: string }) => d.date)).toEqual(["2026-11-12"]);
    expect(v.error).toBeUndefined();
  });

  it("a page request calls no source and writes no calendar row, even when every source is due", async () => {
    const s = await page(at(12, 8, 0));
    const cal = feed([event("standup", iso(12, 9, 30), iso(12, 10, 0))]);
    await s.sync([{ name: "work", source: { events: cal.events } }]);
    s.clock.advance(60 * 60_000); // past the next due time
    cal.fail = true;
    const before = await s.rows();
    await s.get();
    await s.get();
    expect(cal.calls).toBe(1);
    expect(await s.rows()).toEqual(before);
  });
});
