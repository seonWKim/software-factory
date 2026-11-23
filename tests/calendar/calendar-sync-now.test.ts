import { describe, expect, it } from "vitest";
import { CALENDAR_SYNC_MS, MAX_SPAN_DAYS, calendarSql, runSyncRequests } from "../../src/calendar/index.js";
import { rangeWindow } from "../../src/calendar/calendar-sync.js";
import calendarCommand, { WAIT_MS, WAIT_SCHEDULE, WAIT_TICK_MS, parseCalendarArgs, runCalendarSync } from "../../src/cli/handlers/calendar/calendar.command.js";
import type { UserId } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { CalendarSource } from "../../src/interfaces/calendar-source.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { ManualTickGenerator } from "../../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { UiCalendar } from "../../src/ui/calendar-api.js";
import { HealthMonitor } from "../../src/ui/health.js";
import type { UiPauses } from "../../src/ui/pause-api.js";
import { type ApiDeps, type UiRequest, respond } from "../../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../../src/ui/settings-api.js";
import { FakeAuth } from "../helpers/fakes/runner.js";
import { FakeSource } from "../helpers/fakes/source.js";
import { cleanScanner, config, silent } from "../helpers/fakes/config.js";
import { newStore } from "../helpers/store.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";

// The on-demand calendar sync (design 02-tasks-calendar, 2026-11-22): POST /api/v1/calendar/sync and `factory calendar
// sync` store a request, the controller's calendar unit runs it on its next poll for the local days asked, and the
// scheduled sync keeps what it stored. Fake sources, a FakeClock and manual ticks only: no network, no real time.

/** A local wall-clock instant on 2026-<month>-<day>, as ISO, so the tests hold in any time zone. */
const at = (month: number, day: number, h = 0) => new Date(2026, month - 1, day, h).toISOString();
const NOW = new Date(2026, 10, 21, 9, 0);
const HOST = "127.0.0.1:4310";
const OWNER = "local:owner@example.com" as UserId;
const SYNC = "/api/v1/calendar/sync";

async function harness(calendar: { name: string; source: CalendarSource }[], o: { as?: UserId } = {}) {
  const clock = new FakeClock(NOW);
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const db = calendarSql(store);
  const role = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, calendar });
  const step = async () => (await role.unit("calendar")).calendarStep();
  const csrfToken = newCsrfToken();
  // The Calendar section's routes are wired; this test calls only POST /sync, which never runs the connect flow.
  const flow = new UiCalendar({ plugins: [], listed: async () => [], run: async () => ({ sync: null }) });
  const settings = { csrfToken, calendar: flow } as unknown as UiSettings;
  const pauses: UiPauses = { principal: async () => o.as ?? OWNER, authorize: async () => ({ allow: true }), csrfToken, log: silent };
  const d: ApiDeps = {
    store, clock, lease_ms: 300_000, settings, pauses, scanner: new PatternEgressScanner(async () => []), health: new HealthMonitor(async () => [], clock),
  };
  const parse = (r: { status: number; body: string }) => ({ status: r.status, body: JSON.parse(r.body) as Record<string, unknown> });
  const post = async (body: unknown, over: Partial<UiRequest> = {}) =>
    parse(await respond(d, { method: "POST", url: SYNC, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken, body: JSON.stringify(body), ...over }));
  const days = async (from: string, to: string) => {
    const r = parse(await respond(d, { method: "GET", url: `/api/v1/calendar/events?from=${from}&to=${to}`, host: HOST }));
    return r.body as { days: { date: string; synced: boolean; events: { id: string }[] }[]; calendar: { source: string; failed: boolean }[]; sync_pending: boolean };
  };
  const state = async (source: string) => (await db.all("SELECT * FROM calendar_sync_state WHERE source = ?", [source]))[0];
  return { clock, db, step, post, days, state };
}

const past = calendarEvent("past", { starts_at: at(11, 3, 10), ends_at: at(11, 3, 11) });
const soon = calendarEvent("soon", { starts_at: at(11, 23, 10), ends_at: at(11, 23, 11) });

describe("on-demand calendar sync", () => {
  it("a past range synced on request stores its events, counts as synced and survives the next scheduled sync", async () => {
    const work = new FakeCalendarSource([past, soon]);
    work.inWindow = true;
    const { clock, step, post, days, state } = await harness([{ name: "work", source: work }]);
    await step();
    const due = (await state("work"))!.next_sync_at;
    expect((await days("2026-11-02", "2026-11-08")).days.every((d) => !d.synced)).toBe(true);

    const r = await post({ from: "2026-11-02", to: "2026-11-08" });
    expect(r).toMatchObject({ status: 202, body: { from: "2026-11-02", to: "2026-11-08", state: "pending", created: true } });
    expect((await days("2026-11-02", "2026-11-08")).sync_pending).toBe(true);
    await step();
    // The read asked for local midnight of the 2nd through local midnight after the 8th.
    expect(work.windows.at(-1)).toEqual({ from: at(11, 2), to: at(11, 9) });
    expect(rangeWindow("2026-11-02", "2026-11-08")).toEqual({ from: at(11, 2), to: at(11, 9) });
    const week = await days("2026-11-02", "2026-11-08");
    expect(week.sync_pending).toBe(false);
    expect(week.days.map((d) => d.synced)).toEqual([true, true, true, true, true, true, true]);
    expect(week.days.find((d) => d.date === "2026-11-03")!.events.map((e) => e.id)).toEqual(["past"]);
    // The on-demand sync left the schedule alone.
    expect((await state("work"))!.next_sync_at).toBe(due);

    // The next scheduled sync replaces only its own window: the past range and its coverage stay.
    work.list = [past, calendarEvent("later", { starts_at: at(11, 24, 10), ends_at: at(11, 24, 11) })];
    clock.advance(CALENDAR_SYNC_MS);
    await step();
    const after = await days("2026-11-02", "2026-11-24");
    const byDate = new Map(after.days.map((d) => [d.date, d]));
    expect(byDate.get("2026-11-03")).toMatchObject({ synced: true, events: [{ id: "past" }] });
    expect(byDate.get("2026-11-08")!.synced).toBe(true);
    // Days between the asked range and the scheduled window stay not synced.
    expect(byDate.get("2026-11-12")!.synced).toBe(false);
    expect(byDate.get("2026-11-23")!.events).toEqual([]);
    expect(byDate.get("2026-11-24")!.events.map((e) => e.id)).toEqual(["later"]);
  });

  it("a failed on-demand read stores the source's error and time, keeps its events, and the read reports it failed", async () => {
    const work = new FakeCalendarSource([past, soon]);
    const home = new FakeCalendarSource([calendarEvent("h", { starts_at: at(11, 4, 9), ends_at: at(11, 4, 10) })]);
    const { clock, db, step, post, days, state } = await harness([{ name: "home", source: home }, { name: "work", source: work }]);
    await step();
    const due = (await state("work"))!.next_sync_at;
    work.failWith = "calendar provider unreachable";
    clock.advance(60_000);
    expect((await post({ from: "2026-11-02", to: "2026-11-08" })).status).toBe(202);
    await step();
    expect(await state("work")).toMatchObject({ error: "calendar provider unreachable", error_at: clock.now().toISOString(), next_sync_at: due, synced_at: NOW.toISOString() });
    expect(await state("home")).toMatchObject({ error: null });
    const r = await days("2026-11-02", "2026-11-08");
    // The page's "Sync failed" notice reads `failed`; the week is not synced, since work never read it.
    expect(r.calendar).toEqual([{ source: "home", synced_at: NOW.toISOString(), failed: false }, { source: "work", synced_at: NOW.toISOString(), failed: true }]);
    expect(r.days.every((d) => !d.synced)).toBe(true);
    expect((await db.all("SELECT event_id FROM calendar_events WHERE source = 'work' ORDER BY event_id")).map((e) => e.event_id)).toEqual(["past", "soon"]);
    const [request] = await db.all("SELECT results, done_at FROM calendar_sync_requests");
    expect(JSON.parse(String(request!.results))).toEqual([{ source: "home", ok: true, events: 1 }, { source: "work", ok: false, error: "calendar provider unreachable" }]);
  });

  it("one pending request per range: a second ask returns the pending one and writes no row; once done, a new ask stores a new one", async () => {
    const work = new FakeCalendarSource([past]);
    const { db, step, post } = await harness([{ name: "work", source: work }]);
    const first = await post({ from: "2026-11-02", to: "2026-11-08" });
    const again = await post({ from: "2026-11-02", to: "2026-11-08" });
    expect(again.body).toMatchObject({ id: first.body.id, created: false });
    expect(await db.all("SELECT id FROM calendar_sync_requests")).toEqual([{ id: first.body.id }]);
    await step();
    const reads = work.windows.length;
    // Safe to run twice: a second run (another replica, or the next poll) finds nothing pending and reads nothing.
    await runSyncRequests(db, [{ name: "work", source: work }], NOW.getTime());
    expect(work.windows).toHaveLength(reads);
    const next = await post({ from: "2026-11-02", to: "2026-11-08" });
    expect(next.body).toMatchObject({ created: true });
    expect(next.body.id).not.toBe(first.body.id);
  });

  it("a request taken by one controller is not read again by another until its lease ends", async () => {
    const work = new FakeCalendarSource([past]);
    const { db, post } = await harness([]);
    await post({ from: "2026-11-02", to: "2026-11-08" });
    await db.run("UPDATE calendar_sync_requests SET claimed_at = ?", [NOW.toISOString()]);
    expect(await runSyncRequests(db, [{ name: "work", source: work }], NOW.getTime() + 1_000)).toEqual([]);
    expect(work.windows).toEqual([]);
    expect(await runSyncRequests(db, [{ name: "work", source: work }], NOW.getTime() + 60_000)).toEqual([{ source: "work", ok: true, events: 1 }]);
  });

  it("POST /api/v1/calendar/sync refuses a bad range with 400 and its reason, a non-owner with 403, and a failed guard, before any row", async () => {
    const { db, post } = await harness([]);
    const owner = await harness([], { as: "local:other@example.com" as UserId });
    const cases: [unknown, RegExp][] = [
      [{ from: "2026-11-02" }, /to must be a date as YYYY-MM-DD/],
      [{ from: "2026-11-9", to: "2026-11-15" }, /from must be a date/],
      [{ from: "2026-11-15", to: "2026-11-09" }, /from must not be later than to/],
      [{ from: "2026-11-01", to: "2027-01-02" }, new RegExp(`at most ${MAX_SPAN_DAYS} days`)],
      [{ from: "2026-11-01", to: "2026-11-02", source: "work" }, /unknown field "source"/],
      [["2026-11-01"], /JSON object/],
    ];
    for (const [body, reason] of cases) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.body.error)).toMatch(reason);
    }
    const other = await owner.post({ from: "2026-11-02", to: "2026-11-08" });
    expect(other.status).toBe(403);
    expect(String(other.body.error)).toMatch(/Only the owner syncs the calendars/);
    expect((await post({ from: "2026-11-02", to: "2026-11-08" }, { csrfToken: "wrong" })).status).toBe(403);
    expect((await post({ from: "2026-11-02", to: "2026-11-08" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ from: "2026-11-02", to: "2026-11-08" }, { contentType: "text/plain" })).status).toBe(415);
    expect(await db.all("SELECT id FROM calendar_sync_requests")).toEqual([]);
    expect(await owner.db.all("SELECT id FROM calendar_sync_requests")).toEqual([]);
    expect((await post({ from: "2026-11-01", to: "2027-01-01" })).status).toBe(202);
  });
});

describe("factory calendar sync", () => {
  /** The command's run over the harness's store, on manual ticks the test drives by FakeClock time. */
  function cli(db: Parameters<typeof runCalendarSync>[0]["db"], range: { from: string; to: string }) {
    const ticks = new ManualTickGenerator();
    const lines: string[] = [];
    const errors: string[] = [];
    const done = runCalendarSync({ db, by: OWNER, ticks, print: (l) => lines.push(l), error: (l) => errors.push(l) }, range);
    return { done, lines, errors, tick: (ms: number) => ticks.tick(WAIT_SCHEDULE, ms) };
  }

  it("is a command named calendar, and checks the range as the dashboard does, before the store opens", () => {
    expect(calendarCommand.names).toContain("calendar");
    expect(parseCalendarArgs(["sync", "--from", "2026-11-02", "--to", "2026-11-08"])).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(parseCalendarArgs(["sync", "--to", "2026-11-08", "--from", "2026-11-02"])).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(parseCalendarArgs(["sync", "--from", "2026-11-01", "--to", "2027-01-02"])).toEqual({ error: `from through to must span at most ${MAX_SPAN_DAYS} days` });
    expect(parseCalendarArgs(["sync", "--from", "2026-11-02"])).toEqual({ error: "to must be a date as YYYY-MM-DD, e.g. 2026-11-09" });
    expect(parseCalendarArgs(["sync", "--from"])).toEqual({ error: "--from needs a date" });
    expect(parseCalendarArgs(["sync", "--days", "3"])).toEqual({ error: 'unknown argument "--days"' });
    expect(parseCalendarArgs([])).toEqual({ error: "factory calendar needs a subcommand" });
  });

  it("stores the request, waits for the controller, prints each source's count and exits 0", async () => {
    const work = new FakeCalendarSource([past, soon]);
    const { clock, db, step } = await harness([{ name: "work", source: work }]);
    const run = cli(db, { from: "2026-11-02", to: "2026-11-08" });
    await run.tick(clock.now().getTime());
    expect(run.lines).toEqual(["Sync requested for 2026-11-02 through 2026-11-08; waiting for the controller (up to 2 minutes)."]);
    clock.advance(WAIT_TICK_MS);
    await step();
    await run.tick(clock.now().getTime());
    expect(await run.done).toBe(0);
    expect(run.lines.slice(1)).toEqual(["work: 2 events"]);
    expect(run.errors).toEqual([]);
  });

  it("exits 1 and prints the stored error when a source failed", async () => {
    const work = new FakeCalendarSource([past]);
    const home = new FakeCalendarSource();
    home.failWith = "boom";
    const { clock, db, step } = await harness([{ name: "home", source: home }, { name: "work", source: work }]);
    const run = cli(db, { from: "2026-11-02", to: "2026-11-08" });
    await run.tick(clock.now().getTime());
    await step();
    await run.tick(clock.now().getTime() + WAIT_TICK_MS);
    expect(await run.done).toBe(1);
    expect(run.lines.slice(1)).toEqual(["work: 1 event"]);
    expect(run.errors).toEqual(["home: failed: boom"]);
  });

  it("exits 1 when the controller does not finish within 2 minutes; the request stays pending", async () => {
    const { clock, db } = await harness([]);
    const run = cli(db, { from: "2026-11-02", to: "2026-11-08" });
    const t0 = clock.now().getTime();
    await run.tick(t0);
    await run.tick(t0 + WAIT_MS - WAIT_TICK_MS);
    expect(run.errors).toEqual([]);
    await run.tick(t0 + WAIT_MS);
    expect(await run.done).toBe(1);
    expect(run.errors).toEqual([expect.stringMatching(/did not finish the sync within 2 minutes/)]);
    expect(await db.all("SELECT done_at FROM calendar_sync_requests")).toEqual([{ done_at: null }]);
  });

  it("a second CLI ask while the dashboard's request waits joins it instead of storing another", async () => {
    const { clock, db, post } = await harness([]);
    const first = await post({ from: "2026-11-02", to: "2026-11-08" });
    const run = cli(db, { from: "2026-11-02", to: "2026-11-08" });
    await run.tick(clock.now().getTime());
    expect(run.lines).toEqual(["A sync is pending already for 2026-11-02 through 2026-11-08; waiting for the controller (up to 2 minutes)."]);
    expect(await db.all("SELECT id FROM calendar_sync_requests")).toEqual([{ id: first.body.id }]);
    await run.tick(clock.now().getTime() + WAIT_MS);
    expect(await run.done).toBe(1);
  });
});
