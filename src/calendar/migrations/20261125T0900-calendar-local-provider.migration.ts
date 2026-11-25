// A local event's copy in a connected calendar (design 02-tasks-calendar, copy to a connected calendar, 2026-11-25):
// on `calendar_local_events`, `provider` (the calendar plugin's name that holds the copy), `provider_event_id` (the ID
// that calendar's own read reports for it, so the calendar read shows the event once) and `sync_error` (the last copy
// write's error, kept on the event and never retried on a poll); and `calendar_write_access`, whether each connected
// calendar takes writes, so the calendar read answers it from the store and never calls the provider. Neutral: no
// provider's fields, no token or scope. Additive: three nullable columns and one new table, no backfill (no event has
// a copy yet), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

const COLUMNS = ["provider", "provider_event_id", "sync_error"] as const;

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const have = await tableColumns(db, "calendar_local_events");
    for (const c of COLUMNS) if (!have.includes(c)) await db.run(`ALTER TABLE calendar_local_events ADD COLUMN ${c} TEXT`);
    await db.run(`CREATE TABLE IF NOT EXISTS calendar_write_access (
    source    TEXT PRIMARY KEY,
    writable  INTEGER NOT NULL
  )`);
  },
});
