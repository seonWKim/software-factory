// The dashboard's read of the calendar component's tables (design 02-tasks, calendar views): the stored events and
// each source's last sync, as the sync left them. Read-only: no source is called and no row is written, so a page
// request works the same while a source is down. The SQL of the component's tables stays in this component.

import type { SqlDriver } from "../state/index.js";

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

export interface StoredCalendar {
  readonly events: readonly StoredEvent[];
  readonly sources: readonly SourceSync[];
}

/** Every stored event (by start, then source and ID) and every source's sync state (by name). Two reads, no write. */
export async function readCalendar(db: SqlDriver): Promise<StoredCalendar> {
  const events = await db.all("SELECT source, event_id, title, starts_at, ends_at, all_day FROM calendar_events ORDER BY starts_at, source, event_id");
  const sources = await db.all("SELECT source, synced_at, error_at FROM calendar_sync_state ORDER BY source");
  return {
    events: events.map((r) => ({
      source: String(r.source), id: String(r.event_id), title: String(r.title), starts_at: String(r.starts_at), ends_at: String(r.ends_at), all_day: Number(r.all_day) === 1,
    })),
    sources: sources.map((r) => ({ source: String(r.source), synced_at: r.synced_at == null ? null : String(r.synced_at), failed: r.error_at != null })),
  };
}
