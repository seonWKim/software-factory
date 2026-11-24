// The owner's own events (design 02-tasks-calendar, local events, 2026-11-24): `calendar_local_events`, one row per
// event the owner added (src/calendar/calendar-local.ts), with its repeat (`none`, `daily`, `weekly` or `monthly`, no
// end date) and the identity that added it, never a display name. Additive: one new table and its index on
// `starts_at`, no backfill (it starts empty), safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS calendar_local_events (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    all_day     INTEGER NOT NULL,
    repeats     TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS calendar_local_events_starts ON calendar_local_events (starts_at)",
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
