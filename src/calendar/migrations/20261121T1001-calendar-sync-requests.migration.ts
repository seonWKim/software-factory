// The calendar component's on-demand sync (design 02-tasks-calendar, 2026-11-22). `calendar_sync_requests`: one row
// per Sync the dashboard or the CLI asked for, the local days `from_date` through `to_date`; `pending_key` holds the
// range while the request waits and is cleared when it is done, so its unique index allows one pending request per
// range. `claimed_at` is the lease of the controller running it; `results` the outcome per source, as JSON.
// `calendar_synced_ranges`: one row per source and window an on-demand sync read successfully, so a day it covered
// counts as synced after the scheduled sync moves on. Neutral: no provider's fields. Additive: two new tables.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS calendar_sync_requests (
    id            TEXT PRIMARY KEY,
    from_date     TEXT NOT NULL,
    to_date       TEXT NOT NULL,
    pending_key   TEXT,
    requested_by  TEXT NOT NULL,
    requested_at  TEXT NOT NULL,
    claimed_at    TEXT,
    done_at       TEXT,
    results       TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS calendar_sync_requests_pending ON calendar_sync_requests (pending_key)",
  `CREATE TABLE IF NOT EXISTS calendar_synced_ranges (
    source     TEXT NOT NULL,
    from_at    TEXT NOT NULL,
    to_at      TEXT NOT NULL,
    synced_at  TEXT NOT NULL,
    PRIMARY KEY (source, from_at, to_at)
  )`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
