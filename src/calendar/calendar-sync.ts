// The calendar sync (design 02-tasks-calendar): each configured source is read at most once per CALENDAR_SYNC_MS
// and its answer replaces its rows in calendar_events that overlap the window it asked about; rows outside it stay.
// The due time lives in calendar_sync_state and is claimed by a conditional write, so two replicas never sync one
// source in one period. A Sync the dashboard or the CLI asks for is a row in calendar_sync_requests that the
// controller runs on its next poll (runSyncRequests); its windows are kept in calendar_synced_ranges. A failed read
// stores its error on the source's state row and keeps the source's last events. The SQL of the component's tables
// stays in this file and calendar-read.ts.

import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlExecutor } from "../state/index.js";
import type { EventDetails } from "./event-details.js";

/** How often each source syncs. */
export const CALENDAR_SYNC_MS = 5 * 60_000;
const WINDOW_BACK_MS = 86_400_000;
const WINDOW_AHEAD_MS = 30 * 86_400_000;
/** A stored error is cut to this many characters. */
const ERROR_MAX = 1000;
/** How long a controller holds a sync request it took; after that another may run it (the first one stopped). */
const REQUEST_LEASE_MS = 60_000;

/**
 * One event as a source answers it. The same shape as CalendarEvent (src/interfaces/calendar-source.ts), restated
 * because a component imports no legacy folder (RFC 0015 §9); compose hands the built sources over, so the
 * typecheck keeps the two in step.
 */
export interface FeedEvent {
  readonly id: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly all_day: boolean;
  readonly updated_at: string | null;
  /** Its calendar, place, notes, people and links (event-details.ts); absent when the source answers none. */
  readonly details?: EventDetails;
}

/** What the sync calls on a source: CalendarSource's one read. */
export interface CalendarFeed {
  events(window: { from: string; to: string }): Promise<readonly FeedEvent[]>;
}

/** A configured source and the name config selects it by: the key of its rows in both tables. */
export interface NamedFeed {
  readonly name: string;
  readonly source: CalendarFeed;
}

export type SyncOutcome = { source: string; ok: true; events: number } | { source: string; ok: false; error: string };

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The window a sync at `atMs` asks about, as ISO instants: from a day back to 30 days ahead of the sync's time. The
 * sync passes it to each source, and the dashboard's Calendar read (src/ui/calendar-events-api.ts) takes a day as
 * synced only when it lies inside the window of each source's last successful sync, so the two never disagree.
 */
export function syncWindow(atMs: number): { from: string; to: string } {
  return { from: iso(atMs - WINDOW_BACK_MS), to: iso(atMs + WINDOW_AHEAD_MS) };
}

/** The most days one read or one on-demand sync covers, `from` and `to` included: a month grid needs 31. */
export const MAX_SPAN_DAYS = 62;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
/** A `YYYY-MM-DD` that names a real day (no 2026-02-30). */
const isDate = (v: string): boolean => DATE.test(v) && new Date(utcDay(v)).toISOString().slice(0, 10) === v;

/**
 * Why the range of local days is refused, or null: each a `YYYY-MM-DD` date, `from` not after `to`, at most
 * MAX_SPAN_DAYS days. The dashboard's Calendar read, its sync route and `factory calendar sync` share it.
 */
export function rangeError(from: string | null, to: string | null): string | null {
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v === null || !isDate(v)) return `${name} must be a date as YYYY-MM-DD, e.g. 2026-11-09`;
  }
  if (from! > to!) return "from must not be later than to";
  if (Math.round((utcDay(to!) - utcDay(from!)) / 86_400_000) + 1 > MAX_SPAN_DAYS) return `from through to must span at most ${MAX_SPAN_DAYS} days`;
  return null;
}

/**
 * The window an on-demand sync of the local days `from` through `to` (YYYY-MM-DD) asks about: from local midnight of
 * the first day through local midnight after the last, in this process's time zone, as ISO instants.
 */
export function rangeWindow(from: string, to: string): { from: string; to: string } {
  const midnight = (date: string, plus: number) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return iso(new Date(y, m - 1, d + plus).getTime());
  };
  return { from: midnight(from, 0), to: midnight(to, 1) };
}

/**
 * Syncs every source in `feeds` that is due at `nowMs`: one read of the state rows, then for each due source the
 * claim, the source's read, and its rows. No feeds: nothing is read or written. Safe to run twice and on several
 * replicas: a source whose claim another caller won is skipped. Returns what each synced source did.
 */
export async function syncCalendars(db: SqlDriver, feeds: readonly NamedFeed[], nowMs: number): Promise<SyncOutcome[]> {
  if (feeds.length === 0) return [];
  const now = iso(nowMs);
  const next = iso(nowMs + CALENDAR_SYNC_MS);
  const stored = new Map(
    (await db.all(`SELECT source, next_sync_at FROM calendar_sync_state WHERE source IN (${feeds.map(() => "?").join(", ")})`, feeds.map((f) => f.name)))
      .map((r) => [String(r.source), String(r.next_sync_at)]),
  );
  const out: SyncOutcome[] = [];
  for (const { name, source } of feeds) {
    const due = stored.get(name);
    if (due !== undefined && due > now) continue;
    if (!(await claim(db, name, due === undefined, now, next))) continue;
    try {
      const window = syncWindow(nowMs);
      const events = await source.events(window);
      await db.transaction(async (tx) => {
        await replaceEvents(tx, name, events, window, now);
        await tx.run("UPDATE calendar_sync_state SET synced_at = ?, error = NULL, error_at = NULL WHERE source = ?", [now, name]);
      });
      out.push({ source: name, ok: true, events: events.length });
    } catch (err) {
      out.push(await failed(db, name, err, now));
    }
  }
  return out;
}

/** The read's error stored on the source's state row (made, due now, when it has none) and returned. */
async function failed(db: SqlDriver, source: string, err: unknown, now: string): Promise<SyncOutcome> {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
  await db.run("INSERT OR IGNORE INTO calendar_sync_state (source, next_sync_at) VALUES (?, ?)", [source, now]);
  await db.run("UPDATE calendar_sync_state SET error = ?, error_at = ? WHERE source = ?", [error, now, source]);
  return { source, ok: false, error };
}

/** A stored on-demand sync: the local days `from` through `to`, and each source's outcome once it is done. */
export interface SyncRequest {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly requested_at: string;
  /** Null while the request waits for the controller. */
  readonly done_at: string | null;
  readonly results: readonly SyncOutcome[] | null;
}

const REQUEST_COLUMNS = "id, from_date, to_date, requested_at, done_at, results";

function requestOf(r: Record<string, unknown>): SyncRequest {
  return {
    id: String(r.id), from: String(r.from_date), to: String(r.to_date), requested_at: String(r.requested_at),
    done_at: r.done_at == null ? null : String(r.done_at), results: r.results == null ? null : (JSON.parse(String(r.results)) as SyncOutcome[]),
  };
}

/**
 * Stores a request to sync every source for the local days `from` through `to` (checked by the caller). One
 * pending request per range: while one waits, it is returned (`created: false`) and no row is written.
 */
export async function requestCalendarSync(db: SqlDriver, r: { from: string; to: string; by: string; nowMs: number }): Promise<{ request: SyncRequest; created: boolean }> {
  const key = `${r.from}/${r.to}`;
  const created = (await db.run(
    `INSERT OR IGNORE INTO calendar_sync_requests (id, from_date, to_date, pending_key, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [`cs_${randomUUID()}`, r.from, r.to, key, r.by, iso(r.nowMs)],
  )) === 1;
  const [row] = await db.all(`SELECT ${REQUEST_COLUMNS} FROM calendar_sync_requests WHERE pending_key = ?`, [key]);
  if (row === undefined) throw new Error("the calendar sync request was done before it could be read back");
  return { request: requestOf(row), created };
}

/** One stored request by ID, or null. */
export async function readSyncRequest(db: SqlDriver, id: string): Promise<SyncRequest | null> {
  const [row] = await db.all(`SELECT ${REQUEST_COLUMNS} FROM calendar_sync_requests WHERE id = ?`, [id]);
  return row === undefined ? null : requestOf(row);
}

/**
 * Runs every pending sync request at `nowMs`: each is taken by a conditional write (a lease, so a stopped run is
 * taken again after REQUEST_LEASE_MS), every source in `feeds` is read for the request's days, and the request is
 * marked done with each source's outcome. A success replaces only the source's events that overlap the window and
 * records the window as covered; a failure is stored on the source's state row. The scheduled due time is never
 * touched. Safe to run twice: a second run reads again and writes the same rows. Returns the outcomes.
 */
export async function runSyncRequests(db: SqlDriver, feeds: readonly NamedFeed[], nowMs: number): Promise<SyncOutcome[]> {
  const now = iso(nowMs);
  const pending = await db.all("SELECT id, from_date, to_date FROM calendar_sync_requests WHERE done_at IS NULL ORDER BY requested_at, id");
  const out: SyncOutcome[] = [];
  for (const r of pending) {
    const id = String(r.id);
    const taken = await db.run(
      "UPDATE calendar_sync_requests SET claimed_at = ? WHERE id = ? AND done_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)",
      [now, id, iso(nowMs - REQUEST_LEASE_MS)],
    );
    if (taken !== 1) continue;
    const window = rangeWindow(String(r.from_date), String(r.to_date));
    const results: SyncOutcome[] = [];
    for (const { name, source } of feeds) {
      try {
        const events = await source.events(window);
        await db.transaction(async (tx) => {
          await replaceEvents(tx, name, events, window, now);
          await tx.run("INSERT OR IGNORE INTO calendar_synced_ranges (source, from_at, to_at, synced_at) VALUES (?, ?, ?, ?)", [name, window.from, window.to, now]);
          await tx.run("UPDATE calendar_synced_ranges SET synced_at = ? WHERE source = ? AND from_at = ? AND to_at = ?", [now, name, window.from, window.to]);
          await tx.run("UPDATE calendar_sync_state SET error = NULL, error_at = NULL WHERE source = ?", [name]);
        });
        results.push({ source: name, ok: true, events: events.length });
      } catch (err) {
        results.push(await failed(db, name, err, now));
      }
    }
    await db.run("UPDATE calendar_sync_requests SET done_at = ?, pending_key = NULL, results = ? WHERE id = ? AND done_at IS NULL", [now, JSON.stringify(results), id]);
    out.push(...results);
  }
  return out;
}

/**
 * Takes the source's sync for this period: its state row inserted with the next due time (a first sync), or moved
 * to it where it is due. False when another caller took it first.
 */
async function claim(db: SqlDriver, source: string, first: boolean, now: string, next: string): Promise<boolean> {
  if (first) {
    if ((await db.run(`INSERT OR IGNORE INTO calendar_sync_state (source, next_sync_at) VALUES (?, ?)`, [source, next])) === 1) return true;
  }
  return (await db.run("UPDATE calendar_sync_state SET next_sync_at = ? WHERE source = ? AND next_sync_at <= ?", [next, source, now])) === 1;
}

/**
 * The source's stored events that overlap `window` (the test core/tasks.ts uses for a day) replaced by `events`;
 * its events outside the window stay. An answered event already stored outside the window is replaced too.
 */
async function replaceEvents(tx: SqlExecutor, source: string, events: readonly FeedEvent[], window: { from: string; to: string }, now: string): Promise<void> {
  const [from, to] = [Date.parse(window.from), Date.parse(window.to)];
  const stored = await tx.all("SELECT event_id, starts_at, ends_at FROM calendar_events WHERE source = ?", [source]);
  const answered = new Set(events.map((e) => e.id));
  for (const r of stored) {
    const [start, end] = [Date.parse(String(r.starts_at)), Date.parse(String(r.ends_at))];
    const overlaps = start < to && (end > from || start >= from);
    if (overlaps || answered.has(String(r.event_id))) await tx.run("DELETE FROM calendar_events WHERE source = ? AND event_id = ?", [source, String(r.event_id)]);
  }
  for (const e of events) {
    await tx.run(
      "INSERT INTO calendar_events (source, event_id, title, starts_at, ends_at, all_day, updated_at, synced_at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [source, e.id, e.title, e.starts_at, e.ends_at, e.all_day ? 1 : 0, e.updated_at, now, e.details === undefined ? null : JSON.stringify(e.details)],
    );
  }
}
