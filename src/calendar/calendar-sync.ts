// The calendar sync (design 02-tasks, calendar): each configured source is read at most once per CALENDAR_SYNC_MS
// and its answer replaces its rows in calendar_events. The due time lives in calendar_sync_state and is claimed by a
// conditional write, so two replicas never sync one source in one period. A failed read stores its error on the
// source's state row and keeps the source's last events. The SQL of the component's tables stays in this file.

import type { SqlDriver, SqlExecutor } from "../state/index.js";

/** How often each source syncs. */
export const CALENDAR_SYNC_MS = 5 * 60_000;
/** The window each sync asks about: from a day back to 30 days ahead of the sync's time. */
const WINDOW_BACK_MS = 86_400_000;
const WINDOW_AHEAD_MS = 30 * 86_400_000;
/** A stored error is cut to this many characters. */
const ERROR_MAX = 1000;

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
      const events = await source.events({ from: iso(nowMs - WINDOW_BACK_MS), to: iso(nowMs + WINDOW_AHEAD_MS) });
      await db.transaction((tx) => replaceEvents(tx, name, events, now));
      out.push({ source: name, ok: true, events: events.length });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
      await db.run("UPDATE calendar_sync_state SET error = ?, error_at = ? WHERE source = ?", [error, now, name]);
      out.push({ source: name, ok: false, error });
    }
  }
  return out;
}

/**
 * Takes the source's sync for this period: its state row inserted with the next due time (a first sync), or moved
 * to it where it is due. False when another caller took it first.
 */
async function claim(db: SqlDriver, source: string, first: boolean, now: string, next: string): Promise<boolean> {
  if (first) {
    const insert = db.dialect.name === "sqlite" ? "INSERT OR IGNORE" : "INSERT IGNORE";
    if ((await db.run(`${insert} INTO calendar_sync_state (source, next_sync_at) VALUES (?, ?)`, [source, next])) === 1) return true;
  }
  return (await db.run("UPDATE calendar_sync_state SET next_sync_at = ? WHERE source = ? AND next_sync_at <= ?", [next, source, now])) === 1;
}

/** The source's events replaced by `events`, and its success recorded (the last error cleared), in one transaction. */
async function replaceEvents(tx: SqlExecutor, source: string, events: readonly FeedEvent[], now: string): Promise<void> {
  await tx.run("DELETE FROM calendar_events WHERE source = ?", [source]);
  for (const e of events) {
    await tx.run(
      "INSERT INTO calendar_events (source, event_id, title, starts_at, ends_at, all_day, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [source, e.id, e.title, e.starts_at, e.ends_at, e.all_day ? 1 : 0, e.updated_at, now],
    );
  }
  await tx.run("UPDATE calendar_sync_state SET synced_at = ?, error = NULL, error_at = NULL WHERE source = ?", [now, source]);
}
