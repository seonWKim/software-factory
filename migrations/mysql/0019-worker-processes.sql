-- Worker processes (design §5 Coordination, 2026-11-07, issue #209): the same table as SQLite migration 19. One row
-- per running WorkerPool, keyed by its `<host>:<pid>`, replaced each tick and deleted on a clean stop.
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS worker_processes (
  process_id   VARCHAR(255) NOT NULL PRIMARY KEY,
  pid          INT NOT NULL,
  host         VARCHAR(255) NOT NULL,
  slots        INT NOT NULL,
  max_slots    INT NOT NULL,
  busy         INT NOT NULL,
  index_base   INT NOT NULL,
  started_at   CHAR(24) NOT NULL,
  reported_at  CHAR(24) NOT NULL,
  KEY worker_processes_reported (reported_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
