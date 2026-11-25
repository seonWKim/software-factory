import { describe, expect, it } from "vitest";
import { syncCalendars } from "../src/calendar/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { CalendarCopy, CalendarSyncPort } from "../src/interfaces/calendar-source.js";
import type { SqlDriver } from "../src/state/index.js";
import { UiCalendar } from "../src/ui/calendar-api.js";
import { CALENDAR_EVENTS_PATH } from "../src/ui/calendar-events-api.js";
import { LOCAL_EVENTS_PATH, LOCAL_EVENT_DELETE_PATH, LOCAL_EVENT_EDIT_PATH } from "../src/ui/calendar-local-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import { newCsrfToken, type UiSettings } from "../src/ui/settings-api.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import type { UserId } from "../src/core/types.js";
import { FakeCalendarSource, calendarEvent } from "./calendar/fakes.js";
import { newStore } from "./helpers/store.js";

// A local event's copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar): through the
// local-event routes, one call on the connected calendar's sync port per add, edit or delete, none when it is read-only;
// a failed call keeps the local change and its error on the event, and nothing retries it; the calendar read shows a
// copied event once. The provider is a fake sync port: no test calls a calendar service.

const HOST = "127.0.0.1:4310";
const OWNER = "owner@example.com" as UserId;
const CAL = "fake-calendar";
const at = (day: number, h: number) => new Date(2026, 10, day, h).toISOString();

/** A fake sync port: records each call; `writable` and `failWith` set how it answers. */
class FakePort implements CalendarSyncPort {
  readonly label = "Fake Calendar";
  readonly calls: [string, ...unknown[]][] = [];
  write = true;
  failWith: string | null = null;
  private next = 1;
  async writable() {
    return this.write;
  }
  private call(...c: [string, ...unknown[]]) {
    this.calls.push(c);
    if (this.failWith !== null) throw new Error(this.failWith);
  }
  async add(copy: CalendarCopy) {
    this.call("add", copy.title, copy.repeats);
    return `copy${this.next++}`;
  }
  async edit(id: string, copy: CalendarCopy) {
    this.call("edit", id, copy.title, copy.repeats);
  }
  async remove(id: string) {
    this.call("remove", id);
  }
}

async function harness(o: { connected?: string[] } = {}) {
  const clock = new FakeClock(new Date(2026, 10, 12, 9));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const port = new FakePort();
  const db = (store as unknown as { db: SqlDriver }).db;
  const listed = async () => o.connected ?? [CAL];
  const calendar = new UiCalendar({ plugins: [], listed, run: async () => ({ sync: null }), port: async () => port });
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: OWNER, source: "environment", token }, settings: { calendar } as unknown as UiSettings,
  };
  const post = async (url: string, body: unknown) => {
    const r = await respond(d, { method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
    expect(r.status, r.body).toBe(200);
    return JSON.parse(r.body) as { event: Record<string, unknown>; sync: Record<string, unknown> };
  };
  const get = async (from: string, to: string) => {
    const r = await respond(d, { method: "GET", url: `${CALENDAR_EVENTS_PATH}?from=${from}&to=${to}`, host: HOST });
    return JSON.parse(r.body) as { days: { events: { source: string; id: string; sync_error?: string | null; copied_to?: string | null }[] }[]; copy: unknown };
  };
  const row = async (id: string) => (await db.all("SELECT provider, provider_event_id, sync_error FROM calendar_local_events WHERE id = ?", [id]))[0];
  return { clock, db, port, post, get, row };
}

const GYM = { title: "Gym", starts_at: at(13, 7), ends_at: at(13, 8), repeats: "weekly" };

describe("copy to a connected calendar: read-only", () => {
  it("an add with sync saves the event locally, says sync is unavailable and calls nothing", async () => {
    const h = await harness();
    h.port.write = false;
    const r = await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true });
    expect(r.sync).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/read-only/) });
    expect(h.port.calls).toEqual([]);
    expect(await h.row(r.event.id as string)).toEqual({ provider: null, provider_event_id: null, sync_error: null });
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: false });
  });

  it("with no connected calendar, an add with sync is saved and says sync is unavailable", async () => {
    const h = await harness({ connected: [] });
    const r = await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true });
    expect(r.sync).toMatchObject({ state: "unavailable" });
    expect(h.port.calls).toEqual([]);
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toBeNull();
  });
});

describe("copy to a connected calendar: write access", () => {
  it("add, edit and delete each call the port once; a repeating event's edit and delete act on the whole series", async () => {
    const h = await harness();
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: true });
    const added = await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true });
    const id = added.event.id as string;
    expect(added.sync).toEqual({ state: "synced", provider: CAL });
    expect(h.port.calls).toEqual([["add", "Gym", "weekly"]]);
    expect(await h.row(id)).toEqual({ provider: CAL, provider_event_id: "copy1", sync_error: null });
    await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" });
    expect(h.port.calls.slice(1)).toEqual([["edit", "copy1", "Swim", "weekly"]]);
    const deleted = await h.post(LOCAL_EVENT_DELETE_PATH, { id });
    expect(deleted.sync).toEqual({ state: "synced", provider: CAL });
    expect(h.port.calls.slice(2)).toEqual([["remove", "copy1"]]);
  });

  it("an add without sync calls nothing, and its edit and delete call nothing either", async () => {
    const h = await harness();
    const r = await h.post(LOCAL_EVENTS_PATH, GYM);
    expect(r.sync).toEqual({ state: "off" });
    await h.post(LOCAL_EVENT_EDIT_PATH, { id: r.event.id, title: "Swim" });
    await h.post(LOCAL_EVENT_DELETE_PATH, { id: r.event.id });
    expect(h.port.calls).toEqual([]);
  });

  it("a failed write keeps the local change and shows the error on the event; later reads retry nothing", async () => {
    const h = await harness();
    h.port.failWith = "event add failed (HTTP 500)";
    const r = await h.post(LOCAL_EVENTS_PATH, { ...GYM, repeats: "none", sync: true });
    const id = r.event.id as string;
    expect(r.sync).toEqual({ state: "failed", error: "event add failed (HTTP 500)" });
    expect(r.event.sync_error).toBe("event add failed (HTTP 500)");
    expect(await h.row(id)).toEqual({ provider: null, provider_event_id: null, sync_error: "event add failed (HTTP 500)" });
    for (let i = 0; i < 3; i++) {
      const [event] = (await h.get("2026-11-13", "2026-11-13")).days[0]!.events;
      expect(event).toMatchObject({ source: "local", id, sync_error: "event add failed (HTTP 500)" });
    }
    expect(h.port.calls).toHaveLength(1);
  });

  it("a copied event is shown once: the connected calendar's copy of it is left out of the read, every occurrence", async () => {
    const h = await harness();
    const r = await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true });
    const other = calendarEvent("unrelated", { starts_at: at(13, 12), ends_at: at(13, 13) });
    const copies = [calendarEvent("copy1", { title: "Gym", starts_at: GYM.starts_at, ends_at: GYM.ends_at }), calendarEvent("copy1_20261120", { title: "Gym", starts_at: at(20, 7), ends_at: at(20, 8) })];
    await syncCalendars(h.db, [{ name: CAL, source: new FakeCalendarSource([...copies, other]) }], h.clock.now().getTime());
    const days = (await h.get("2026-11-13", "2026-11-20")).days;
    const shown = days.flatMap((d) => d.events.map((e) => [e.source, e.id]));
    expect(shown).toEqual([["local", r.event.id], [CAL, "unrelated"], ["local", r.event.id]]);
    expect(days[0]!.events[0]!.copied_to).toBe(CAL);
  });
});
