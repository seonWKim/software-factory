import { describe, expect, it } from "vitest";
import { expandLocalEvents, type LocalEvent } from "../../src/calendar/index.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { SqlDriver } from "../../src/state/index.js";
import { CALENDAR_EVENTS_PATH } from "../../src/ui/calendar-events-api.js";
import { LOCAL_EVENTS_PATH, LOCAL_EVENT_DELETE_PATH, LOCAL_EVENT_EDIT_PATH } from "../../src/ui/calendar-local-api.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { newCsrfToken } from "../../src/ui/settings-api.js";
import { type ApiDeps, type UiRequest, respond } from "../../src/ui/server.js";
import { newStore } from "../helpers/store.js";
import type { UserId } from "../../src/core/types.js";

// The owner's own events (design 02-tasks-calendar, local events): the add, edit and delete routes behind the
// commands token, and GET /api/v1/calendar/events placing each event, its repeats expanded, on the local days asked,
// with no calendar connected. Every instant is built in the process's own time zone, so the tests hold in any zone.

const HOST = "127.0.0.1:4310";
const OWNER = "owner@example.com" as UserId;
/** A local wall-clock instant, as ISO. */
const at = (y: number, month: number, day: number, h = 0, m = 0) => new Date(y, month - 1, day, h, m).toISOString();
const NOW = new Date(2026, 10, 12, 9, 0);

async function harness() {
  const clock = new FakeClock(NOW);
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const db = (store as unknown as { db: SqlDriver }).db;
  // No `settings`: no Calendar section wired, so no calendar is connected.
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: OWNER, source: "environment", token },
  };
  const post = async (url: string, body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  const add = async (body: Record<string, unknown>) => {
    const r = await post(LOCAL_EVENTS_PATH, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.event as { id: string }).id;
  };
  const get = async (from: string, to: string) => {
    const r = await respond(d, { method: "GET", url: `${CALENDAR_EVENTS_PATH}?from=${from}&to=${to}`, host: HOST });
    expect(r.status).toBe(200);
    return JSON.parse(r.body) as { time_zone: string; days: Day[]; calendar: unknown[] };
  };
  const rows = async () => db.all("SELECT * FROM calendar_local_events ORDER BY id");
  return { clock, post, add, get, rows };
}

interface Day {
  date: string;
  synced: boolean;
  events: { source: string; id: string; title: string; time: string | null; starts_at: string; ends_at: string; all_day: boolean; repeats: string }[];
}

/** Each day that has an event of `id`, with that event's local start time on it. */
const daysOf = (days: Day[], id: string) => days.flatMap((d) => d.events.filter((e) => e.id === id).map((e) => [d.date, e.time]));

describe("POST /api/v1/calendar/local-events and the calendar read", () => {
  it("stores the added event under the commands actor, and the read returns it for a range that covers it", async () => {
    const h = await harness();
    const id = await h.add({ title: "Dentist", starts_at: at(2026, 11, 13, 15), ends_at: at(2026, 11, 13, 16) });
    const [row] = await h.rows();
    expect(row).toMatchObject({ id, title: "Dentist", starts_at: at(2026, 11, 13, 15), ends_at: at(2026, 11, 13, 16), all_day: 0, repeats: "none", created_by: OWNER, created_at: NOW.toISOString() });
    const r = await h.get("2026-11-12", "2026-11-14");
    expect(r.days.map((d) => d.events.map((e) => [e.source, e.title, e.time]))).toEqual([[], [["local", "Dentist", "15:00"]], []]);
    expect(daysOf((await h.get("2026-11-14", "2026-11-20")).days, id)).toEqual([]);
  });

  it("a retried add with the same id stores one event", async () => {
    const h = await harness();
    const body = { id: "le_retry-0001", title: "Gym", starts_at: at(2026, 11, 13, 7), ends_at: at(2026, 11, 13, 8) };
    expect(await h.add(body)).toBe("le_retry-0001");
    expect(await h.add(body)).toBe("le_retry-0001");
    expect(await h.rows()).toHaveLength(1);
  });

  it("with no calendar connected returns the owner's local events, and no day counts as synced", async () => {
    const h = await harness();
    await h.add({ title: "Holiday", starts_at: at(2026, 11, 13), ends_at: at(2026, 11, 14), all_day: true });
    const r = await h.get("2026-11-13", "2026-11-14");
    expect(r.calendar).toEqual([]);
    expect(r.days[0]!.events).toEqual([expect.objectContaining({ source: "local", title: "Holiday", all_day: true, time: null, details: null })]);
    expect(r.days.map((d) => d.synced)).toEqual([false, false]);
  });

  it("returns this process's time zone as time_zone", async () => {
    const h = await harness();
    expect((await h.get("2026-11-12", "2026-11-12")).time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("repeats in the calendar read", () => {
  it("a weekly repeat shows on each week in the range, at the first start's local time, not before the first start", async () => {
    const h = await harness();
    const id = await h.add({ title: "1:1", starts_at: at(2026, 11, 2, 10, 30), ends_at: at(2026, 11, 2, 11), repeats: "weekly" });
    const r = await h.get("2026-10-20", "2026-11-30");
    expect(daysOf(r.days, id)).toEqual([["2026-11-02", "10:30"], ["2026-11-09", "10:30"], ["2026-11-16", "10:30"], ["2026-11-23", "10:30"], ["2026-11-30", "10:30"]]);
    const one = r.days.find((d) => d.date === "2026-11-16")!.events[0]!;
    expect([one.starts_at, one.ends_at, one.repeats]).toEqual([at(2026, 11, 16, 10, 30), at(2026, 11, 16, 11), "weekly"]);
  });

  it("a daily repeat shows on each day in the range, also one first stored long before it", async () => {
    const h = await harness();
    const id = await h.add({ title: "Standup", starts_at: at(2024, 1, 1, 9), ends_at: at(2024, 1, 1, 9, 15), repeats: "daily" });
    const r = await h.get("2026-11-12", "2026-11-15");
    expect(daysOf(r.days, id)).toEqual([["2026-11-12", "09:00"], ["2026-11-13", "09:00"], ["2026-11-14", "09:00"], ["2026-11-15", "09:00"]]);
  });

  it("a monthly repeat shows on its day of each month in the range", async () => {
    const h = await harness();
    const id = await h.add({ title: "Rent", starts_at: at(2026, 1, 15), ends_at: at(2026, 1, 16), all_day: true, repeats: "monthly" });
    const r = await h.get("2026-03-01", "2026-04-30");
    expect(daysOf(r.days, id)).toEqual([["2026-03-15", null], ["2026-04-15", null]]);
  });

  it("a monthly repeat on the 29th to 31st skips the months without that day", async () => {
    const h = await harness();
    const on29 = await h.add({ title: "29th", starts_at: at(2026, 1, 29, 12), ends_at: at(2026, 1, 29, 13), repeats: "monthly" });
    const on30 = await h.add({ title: "30th", starts_at: at(2026, 1, 30, 12), ends_at: at(2026, 1, 30, 13), repeats: "monthly" });
    const on31 = await h.add({ title: "31st", starts_at: at(2026, 1, 31, 12), ends_at: at(2026, 1, 31, 13), repeats: "monthly" });
    const r = await h.get("2026-02-01", "2026-04-01");
    expect(daysOf(r.days, on29)).toEqual([["2026-03-29", "12:00"]]);
    expect(daysOf(r.days, on30)).toEqual([["2026-03-30", "12:00"]]);
    expect(daysOf(r.days, on31)).toEqual([["2026-03-31", "12:00"]]);
    const april = await h.get("2026-04-01", "2026-05-31");
    expect(daysOf(april.days, on31)).toEqual([["2026-05-31", "12:00"]]);
    expect(daysOf(april.days, on30)).toEqual([["2026-04-30", "12:00"], ["2026-05-30", "12:00"]]);
  });

  it("an occurrence keeps the first's length, overnight ones too, and the expansion is pure over the rows and the range", () => {
    const e: LocalEvent = {
      id: "le_overnight", title: "Night shift", starts_at: at(2026, 11, 1, 22), ends_at: at(2026, 11, 2, 2), all_day: false, repeats: "weekly",
      created_by: OWNER, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    const out = expandLocalEvents([e], "2026-11-09", "2026-11-09");
    expect(out.map((o) => [o.starts_at, o.ends_at])).toEqual([[at(2026, 11, 8, 22), at(2026, 11, 9, 2)]]);
    expect(expandLocalEvents([e], "2026-11-09", "2026-11-09")).toEqual(out);
  });
});

describe("edit and delete", () => {
  it("an edit changes the stored event and every occurrence of its series, and nothing else", async () => {
    const h = await harness();
    const weekly = await h.add({ title: "1:1", starts_at: at(2026, 11, 2, 10), ends_at: at(2026, 11, 2, 11), repeats: "weekly" });
    const other = await h.add({ title: "Lunch", starts_at: at(2026, 11, 3, 12), ends_at: at(2026, 11, 3, 13), repeats: "weekly" });
    const before = (await h.rows()).find((r) => r.id === other);
    h.clock.advance(60_000);
    const r = await h.post(LOCAL_EVENT_EDIT_PATH, { id: weekly, title: "Weekly 1:1", starts_at: at(2026, 11, 2, 14), ends_at: at(2026, 11, 2, 15) });
    expect(r.status).toBe(200);
    expect((await h.rows()).find((x) => x.id === weekly)).toMatchObject({ title: "Weekly 1:1", repeats: "weekly", updated_at: new Date(NOW.getTime() + 60_000).toISOString() });
    expect((await h.rows()).find((x) => x.id === other)).toEqual(before);
    const days = (await h.get("2026-11-01", "2026-11-20")).days;
    expect(daysOf(days, weekly)).toEqual([["2026-11-02", "14:00"], ["2026-11-09", "14:00"], ["2026-11-16", "14:00"]]);
    expect(days.flatMap((d) => d.events.filter((e) => e.id === weekly).map((e) => e.title))).toEqual(["Weekly 1:1", "Weekly 1:1", "Weekly 1:1"]);
    expect(daysOf(days, other)).toEqual([["2026-11-03", "12:00"], ["2026-11-10", "12:00"], ["2026-11-17", "12:00"]]);
  });

  it("an edit can change the repeat; a bad edit is refused and changes nothing; an unknown ID is 404", async () => {
    const h = await harness();
    const id = await h.add({ title: "Run", starts_at: at(2026, 11, 2, 7), ends_at: at(2026, 11, 2, 8), repeats: "daily" });
    const stored = await h.rows();
    for (const body of [{ id, title: " " }, { id, repeats: "yearly" }, { id, ends_at: at(2026, 11, 2, 6) }, { id }, { id, colour: "red" }]) {
      expect((await h.post(LOCAL_EVENT_EDIT_PATH, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await h.rows()).toEqual(stored);
    expect((await h.post(LOCAL_EVENT_EDIT_PATH, { id: "le_missing-001", title: "x" })).status).toBe(404);
    expect((await h.post(LOCAL_EVENT_EDIT_PATH, { id, repeats: "none" })).status).toBe(200);
    expect(daysOf((await h.get("2026-11-01", "2026-11-04")).days, id)).toEqual([["2026-11-02", "07:00"]]);
  });

  it("a delete removes the event and every occurrence of its series, and nothing else", async () => {
    const h = await harness();
    const weekly = await h.add({ title: "1:1", starts_at: at(2026, 11, 2, 10), ends_at: at(2026, 11, 2, 11), repeats: "weekly" });
    const other = await h.add({ title: "Lunch", starts_at: at(2026, 11, 3, 12), ends_at: at(2026, 11, 3, 13) });
    expect((await h.post(LOCAL_EVENT_DELETE_PATH, { id: weekly })).status).toBe(200);
    expect((await h.rows()).map((r) => r.id)).toEqual([other]);
    const days = (await h.get("2026-11-01", "2026-11-30")).days;
    expect(daysOf(days, weekly)).toEqual([]);
    expect(daysOf(days, other)).toEqual([["2026-11-03", "12:00"]]);
    expect((await h.post(LOCAL_EVENT_DELETE_PATH, { id: weekly })).status).toBe(404);
  });
});

describe("refusals", () => {
  it("a bad body (empty title, unknown repeat, end not after start, bad date) gets 400 and stores nothing", async () => {
    const h = await harness();
    const ok = { title: "Call", starts_at: at(2026, 11, 13, 9), ends_at: at(2026, 11, 13, 10) };
    const bodies: Record<string, unknown>[] = [
      { ...ok, title: "" }, { ...ok, title: "   " }, { ...ok, title: 7 },
      { ...ok, repeats: "yearly" }, { ...ok, repeats: "weekdays" },
      { ...ok, ends_at: ok.starts_at }, { ...ok, ends_at: at(2026, 11, 13, 8) },
      { ...ok, starts_at: "2026-02-30T09:00:00Z" }, { ...ok, starts_at: "tomorrow" }, { ...ok, ends_at: "2026-11-13" }, { title: "Call", starts_at: ok.starts_at },
      { ...ok, all_day: "yes" }, { ...ok, id: "not-an-id" }, { ...ok, colour: "red" },
    ];
    for (const body of bodies) {
      const r = await h.post(LOCAL_EVENTS_PATH, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
    expect((await h.post(LOCAL_EVENTS_PATH, [ok])).status).toBe(400);
    expect(await h.rows()).toEqual([]);
  });

  it("each write route refuses a request without the commands token, as the task routes do, and writes nothing", async () => {
    const h = await harness();
    const id = await h.add({ title: "Keep", starts_at: at(2026, 11, 13, 9), ends_at: at(2026, 11, 13, 10) });
    const stored = await h.rows();
    const writes: [string, Record<string, unknown>][] = [
      [LOCAL_EVENTS_PATH, { title: "New", starts_at: at(2026, 11, 14, 9), ends_at: at(2026, 11, 14, 10) }],
      [LOCAL_EVENT_EDIT_PATH, { id, title: "Changed" }],
      [LOCAL_EVENT_DELETE_PATH, { id }],
    ];
    for (const [url, body] of writes) {
      for (const csrfToken of [undefined, "stale"]) {
        const r = await h.post(url, body, { csrfToken });
        expect(r.status, `${url} ${csrfToken}`).toBe(403);
        expect(r.body.code, url).toBe("stale_csrf");
      }
    }
    expect(await h.rows()).toEqual(stored);
  });
});
