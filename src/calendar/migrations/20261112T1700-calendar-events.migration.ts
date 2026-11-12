// The calendar component's tables (design 02-tasks, calendar). `calendar_events`: what each configured source last
// answered, one row per (source, event_id). `calendar_sync_state`: one row per source, with the time its next sync
// is due (stored, not held in memory, so every replica keeps one schedule), its last success, and its last error.
// Neutral: no provider's fields. Additive: two new tables, safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS calendar_events (
    source      TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    all_day     INTEGER NOT NULL,
    updated_at  TEXT,
    synced_at   TEXT NOT NULL,
    PRIMARY KEY (source, event_id)
  )`,
  "CREATE INDEX IF NOT EXISTS calendar_events_starts ON calendar_events (starts_at)",
  `CREATE TABLE IF NOT EXISTS calendar_sync_state (
    source        TEXT PRIMARY KEY,
    next_sync_at  TEXT NOT NULL,
    synced_at     TEXT,
    error         TEXT,
    error_at      TEXT
  )`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
