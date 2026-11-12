// The calendar component's tables (design 02-tasks, calendar). `calendar_events`: what each configured source last
// answered, one row per (source, event_id). `calendar_sync_state`: one row per source, with the time its next sync
// is due (stored, not held in memory, so every replica keeps one schedule), its last success, and its last error.
// Neutral: no provider's fields. Additive: two new tables, safe to rerun.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
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

// Indexes inline, so each statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS calendar_events (
    source      VARCHAR(191) NOT NULL,
    event_id    VARCHAR(191) NOT NULL,
    title       TEXT NOT NULL,
    starts_at   CHAR(24) NOT NULL,
    ends_at     CHAR(24) NOT NULL,
    all_day     TINYINT NOT NULL,
    updated_at  CHAR(24) NULL,
    synced_at   CHAR(24) NOT NULL,
    PRIMARY KEY (source, event_id),
    KEY calendar_events_starts (starts_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS calendar_sync_state (
    source        VARCHAR(191) NOT NULL PRIMARY KEY,
    next_sync_at  CHAR(24) NOT NULL,
    synced_at     CHAR(24) NULL,
    error         TEXT NULL,
    error_at      CHAR(24) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
