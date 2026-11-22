// The dashboard's read of the calendar component's tables (design 02-tasks, calendar views): the stored events and
// each source's last sync, as the sync left them. Read-only: no source is called and no row is written, so a page
// request works the same while a source is down. The SQL of the component's tables stays in this component.

import type { SqlDriver } from "../state/index.js";

/**
 * The SQL store's driver, read by the global key the SQL store marks itself with (impl/store/sql/store-sql.ts
 * SQL_DRIVER, a Symbol.for key), so a component reaches its own tables without loading the legacy store. Throws for
 * a store that is no SQL store. Goes when the runtime hands components their driver.
 */
export function calendarSql(store: object): SqlDriver {
  const db: unknown = (store as { [key: symbol]: unknown })[Symbol.for("software-factory.sql-driver")];
  if (typeof db !== "object" || db === null) throw new Error("the selected store plugin is not a SQL store: the calendar needs one");
  return db as SqlDriver;
}

/** One stored event, keyed by its source's name and the source's own ID. */
export interface StoredEvent {
  readonly source: string;
  readonly id: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly all_day: boolean;
}

/** A source's last sync: when it last succeeded (null: never) and whether its last read failed. */
export interface SourceSync {
  readonly source: string;
  readonly synced_at: string | null;
  readonly failed: boolean;
}

/** A window an on-demand sync read successfully for one source (calendar-sync.ts runSyncRequests), as ISO instants. */
export interface SyncedRange {
  readonly source: string;
  readonly from: string;
  readonly to: string;
}

export interface StoredCalendar {
  readonly events: readonly StoredEvent[];
  readonly sources: readonly SourceSync[];
  readonly ranges: readonly SyncedRange[];
  /** The days (`from` through `to`, YYYY-MM-DD) of each sync request still waiting for the controller. */
  readonly pending: readonly { from: string; to: string }[];
}

/**
 * Every stored event (by start, then source and ID), every source's sync state (by name), the windows on-demand
 * syncs covered and the pending sync requests. Four reads, no write.
 */
export async function readCalendar(db: SqlDriver): Promise<StoredCalendar> {
  const events = await db.all("SELECT source, event_id, title, starts_at, ends_at, all_day FROM calendar_events ORDER BY starts_at, source, event_id");
  const sources = await db.all("SELECT source, synced_at, error_at FROM calendar_sync_state ORDER BY source");
  const ranges = await db.all("SELECT source, from_at, to_at FROM calendar_synced_ranges ORDER BY source, from_at");
  const pending = await db.all("SELECT from_date, to_date FROM calendar_sync_requests WHERE done_at IS NULL ORDER BY requested_at");
  return {
    ranges: ranges.map((r) => ({ source: String(r.source), from: String(r.from_at), to: String(r.to_at) })),
    pending: pending.map((r) => ({ from: String(r.from_date), to: String(r.to_date) })),
    events: events.map((r) => ({
      source: String(r.source), id: String(r.event_id), title: String(r.title), starts_at: String(r.starts_at), ends_at: String(r.ends_at), all_day: Number(r.all_day) === 1,
    })),
    sources: sources.map((r) => ({ source: String(r.source), synced_at: r.synced_at == null ? null : String(r.synced_at), failed: r.error_at != null })),
  };
}

/** A source's sync state for the Settings page's Calendar section: its last success and its last error's text. */
export interface SourceSyncState {
  readonly source: string;
  readonly synced_at: string | null;
  /** The last read's error, as the sync stored it (it never holds a secret value); null after a success. */
  readonly error: string | null;
  readonly error_at: string | null;
}

/** Every source's sync state, by name. One read, no write. */
export async function readSyncStates(db: SqlDriver): Promise<SourceSyncState[]> {
  const rows = await db.all("SELECT source, synced_at, error, error_at FROM calendar_sync_state ORDER BY source");
  const text = (v: unknown) => (v == null ? null : String(v));
  return rows.map((r) => ({ source: String(r.source), synced_at: text(r.synced_at), error: text(r.error), error_at: text(r.error_at) }));
}
