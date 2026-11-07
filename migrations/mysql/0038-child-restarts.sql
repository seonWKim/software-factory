-- Restart history (design 05-restarts): the same table as SQLite migration 38. One row per unexpected child exit
-- the supervisor recorded: its time, its reason and when the store saw it. `restart_key` (the time and a hash of
-- the reason) makes a second write of the same restart, from this replica or another, a no-op. No backfill.
-- Safe to rerun: the table is created only when missing, its keys are part of it.

CREATE TABLE IF NOT EXISTS child_restarts (
  restart_key  VARCHAR(64) NOT NULL PRIMARY KEY,
  at           CHAR(24) NOT NULL,
  reason       TEXT NOT NULL,
  recorded_at  CHAR(24) NOT NULL,
  KEY child_restarts_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
