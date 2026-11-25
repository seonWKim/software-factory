import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localEvents, syncCalendars } from "../../src/calendar/index.js";
import { GoogleCalendarSource, INVALID_GRANT, type HttpClient, TOKEN_URL } from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { CalendarCopy, CalendarSyncPort } from "../../src/interfaces/calendar-source.js";
import type { SqlDriver } from "../../src/state/index.js";
import { UiCalendar } from "../../src/ui/calendar-api.js";
import { CALENDAR_EVENTS_PATH } from "../../src/ui/calendar-events-api.js";
import { LOCAL_EVENTS_PATH, LOCAL_EVENT_DELETE_PATH, LOCAL_EVENT_EDIT_PATH } from "../../src/ui/calendar-local-api.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { newCsrfToken, type UiSettings } from "../../src/ui/settings-api.js";
import { type ApiDeps, respond } from "../../src/ui/server.js";
import type { UserId } from "../../src/core/types.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";
import { newStore } from "../helpers/store.js";

// A local event's copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar): through the
// local-event routes, one call on the connected calendar's sync port per add, edit or delete, none when it is read-only;
// a failed call keeps the local change and its error on the event, and only the event's next save retries it; an edit
// or a delete of a repeating event acts on the whole series; the calendar read shows a copied event once and never
// calls the provider: whether a calendar takes writes is stored state. The provider is a fake sync port (and, for the
// no-call check, the Google source over a fake HTTP client): no test calls a calendar service.

const REPO_ROOT = join(import.meta.dirname, "..", "..");

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

/**
 * The routes over one store, with `port` as the connected calendar's sync port. `write`: the stored write access, as
 * a connect from Settings stores it (true: connected with write access; false: read-only), and the port's answer.
 */
async function harness(o: { connected?: string[]; write?: boolean; port?: CalendarSyncPort } = {}) {
  const clock = new FakeClock(new Date(2026, 10, 12, 9));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const port = new FakePort();
  port.write = o.write ?? true;
  const db = (store as unknown as { db: SqlDriver }).db;
  const access = localEvents(db).writeAccess;
  await access.set(CAL, port.write);
  const listed = async () => o.connected ?? [CAL];
  const calendar = new UiCalendar({ plugins: [{ name: CAL, secrets: [] }], listed, run: async () => ({ sync: null }), port: async () => o.port ?? port, access });
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
  const status = async () => JSON.parse((await respond(d, { method: "GET", url: "/api/v1/calendar", host: HOST })).body) as { plugins: { name: string; write_access: unknown }[] };
  return { clock, db, port, post, get, row, calendar, access, status };
}

const GYM = { title: "Gym", starts_at: at(13, 7), ends_at: at(13, 8), repeats: "weekly" };

describe("copy to a connected calendar: read-only", () => {
  it("an add with sync saves the event locally, says sync is unavailable and calls nothing", async () => {
    const h = await harness({ write: false });
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

/** Each event shown on each day from `from` through `to`, as [date, title]. */
async function titles(h: Awaited<ReturnType<typeof harness>>, from: string, to: string): Promise<[number, string][]> {
  const days = (await h.get(from, to)).days as unknown as { date: string; events: { title: string; source: string }[] }[];
  return days.flatMap((d) => d.events.filter((e) => e.source === "local").map((e) => [Number(d.date.slice(8)), e.title] as [number, string]));
}

describe("copy to a connected calendar: a repeating event's whole series", () => {
  it("an edit changes every occurrence here and its one recurring copy there; a delete removes both whole", async () => {
    const h = await harness();
    const id = (await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true })).event.id as string;
    expect(await titles(h, "2026-11-13", "2026-11-27")).toEqual([[13, "Gym"], [20, "Gym"], [27, "Gym"]]);
    await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" });
    expect(await titles(h, "2026-11-13", "2026-11-27")).toEqual([[13, "Swim"], [20, "Swim"], [27, "Swim"]]);
    expect(h.port.calls).toEqual([["add", "Gym", "weekly"], ["edit", "copy1", "Swim", "weekly"]]);
    await h.post(LOCAL_EVENT_DELETE_PATH, { id });
    expect(await titles(h, "2026-11-13", "2026-11-27")).toEqual([]);
    expect(h.port.calls.slice(2)).toEqual([["remove", "copy1"]]);
  });
});

describe("copy to a connected calendar: saving a failed event again retries its copy", () => {
  it("the add sent again with the same ID retries the add: one more call, the copy kept, the error cleared", async () => {
    const h = await harness();
    h.port.failWith = "event add failed (HTTP 500)";
    const id = (await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true })).event.id as string;
    h.port.failWith = null;
    const again = await h.post(LOCAL_EVENTS_PATH, { ...GYM, id, sync: true });
    expect(again.sync).toEqual({ state: "synced", provider: CAL });
    expect(h.port.calls).toEqual([["add", "Gym", "weekly"], ["add", "Gym", "weekly"]]);
    expect(await h.row(id)).toEqual({ provider: CAL, provider_event_id: "copy1", sync_error: null });
  });

  it("an edit of an event whose first copy failed retries the add, though the edit does not ask for a copy", async () => {
    const h = await harness();
    h.port.failWith = "event add failed (HTTP 500)";
    const id = (await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true })).event.id as string;
    h.port.failWith = null;
    const edited = await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" });
    expect(edited.sync).toEqual({ state: "synced", provider: CAL });
    expect(edited.event.sync_error).toBeNull();
    expect(h.port.calls).toEqual([["add", "Gym", "weekly"], ["add", "Swim", "weekly"]]);
  });

  it("an edit of a copied event whose last edit failed retries the edit; a failed retry keeps the new error", async () => {
    const h = await harness();
    const id = (await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true })).event.id as string;
    h.port.failWith = "event edit failed (HTTP 503)";
    expect((await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" })).sync).toEqual({ state: "failed", error: "event edit failed (HTTP 503)" });
    h.port.failWith = "event edit failed (HTTP 502)";
    expect((await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" })).event.sync_error).toBe("event edit failed (HTTP 502)");
    h.port.failWith = null;
    await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" });
    expect(h.port.calls.slice(1)).toEqual([["edit", "copy1", "Swim", "weekly"], ["edit", "copy1", "Swim", "weekly"], ["edit", "copy1", "Swim", "weekly"]]);
    expect(await h.row(id)).toEqual({ provider: CAL, provider_event_id: "copy1", sync_error: null });
  });

  it("an event that was never asked to copy, and never failed, stays local on an edit", async () => {
    const h = await harness();
    const id = (await h.post(LOCAL_EVENTS_PATH, GYM)).event.id as string;
    expect((await h.post(LOCAL_EVENT_EDIT_PATH, { id, title: "Swim" })).sync).toEqual({ state: "off" });
    expect(h.port.calls).toEqual([]);
  });

  it("the dialog's error text and the design topic say that saving again is the retry", () => {
    const dialog = readFileSync(join(REPO_ROOT, "web", "src", "i18n", "en", "calendar.ts"), "utf8");
    expect(dialog).toMatch(/"calendarCopy\.error": "[^"]*save it again to retry/);
    const design = readFileSync(join(REPO_ROOT, "docs", "design", "02-tasks-calendar.md"), "utf8");
    expect(design).toMatch(/Saving the event again \(an add sent again or an edit\) retries its copy/);
  });
});

describe("the calendar read never calls the provider", () => {
  /** A sync port whose `writable` would call the provider: counted, and failing as a refused token refresh does. */
  class CountingPort extends FakePort {
    asked = 0;
    override async writable(): Promise<boolean> {
      this.asked++;
      throw new Error("invalid_grant");
    }
  }

  it("the copy target's write access comes from stored state: no port call on any read, a failing grant is not retried", async () => {
    const port = new CountingPort();
    const h = await harness({ port });
    for (let i = 0; i < 3; i++) expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: true });
    await h.access.set(CAL, false);
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: false });
    await h.access.set(CAL, null);
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: false });
    expect(port.asked).toBe(0);
  });

  it("a connect stores the write access it asked for once it passes, and a disconnect forgets it", async () => {
    const h = await harness({ write: false });
    expect(await h.calendar.connect(CAL, new Map(), [], false, true)).toEqual({ out: { sync: null } });
    expect(await h.access.get(CAL)).toBe(true);
    await h.calendar.connect(CAL, new Map(), [], false, false);
    expect(await h.access.get(CAL)).toBe(false);
    await h.calendar.disconnect(CAL);
    expect(await h.access.get(CAL)).toBeNull();
  });

  it("GET /api/v1/calendar answers each connected calendar's stored write access, with no port call", async () => {
    const port = new CountingPort();
    const h = await harness({ port, write: false });
    expect((await h.status()).plugins).toEqual([expect.objectContaining({ name: CAL, write_access: false })]);
    await h.access.set(CAL, true);
    expect((await h.status()).plugins).toEqual([expect.objectContaining({ name: CAL, write_access: true })]);
    expect(port.asked).toBe(0);
    const off = await harness({ connected: [] });
    expect((await off.status()).plugins[0]).not.toHaveProperty("write_access");
  });

  it("a write learns the grant from the port and stores it, so the next read answers it without a call", async () => {
    const h = await harness();
    h.port.write = false;
    expect((await h.post(LOCAL_EVENTS_PATH, { ...GYM, sync: true })).sync).toMatchObject({ state: "unavailable" });
    expect(await h.access.get(CAL)).toBe(false);
    expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Fake Calendar", writable: false });
  });

  it("with the Google source, every read makes no HTTP call, while its token refresh fails", async () => {
    const requests: string[] = [];
    const http: HttpClient = async (url) => {
      requests.push(url);
      const body = JSON.stringify(url === TOKEN_URL ? { error: INVALID_GRANT } : {});
      return { status: 400, headers: { get: () => null }, text: async () => body };
    };
    const names = { refreshToken: "R", clientId: "I", clientSecret: "S" } as const;
    const secrets = { get: async () => ({ reveal: () => "value" }) };
    const google = new GoogleCalendarSource({ http, now: () => new Date(2026, 10, 12, 9), secrets, names, calendarIds: [] });
    const h = await harness({ port: google.sync });
    for (let i = 0; i < 3; i++) expect((await h.get("2026-11-13", "2026-11-13")).copy).toEqual({ label: "Google Calendar", writable: true });
    expect(requests).toEqual([]);
  });
});
