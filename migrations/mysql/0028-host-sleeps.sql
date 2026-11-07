-- Host sleeps (design §5 Host sleep, issue #218): the same table as SQLite migration 28. One row per sleep a worker
-- saw (one of its waits ended more than 60 s late), keyed by (worker_id, woke_at), so recording one again keeps one
-- row. `run_id`: the run the worker held, NULL for an idle tick. Ids, a timestamp and a number only.
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS host_sleeps (
  worker_id  VARCHAR(255) NOT NULL,
  woke_at    CHAR(24) NOT NULL,
  gap_ms     BIGINT NOT NULL,
  run_id     VARCHAR(64) NULL,
  PRIMARY KEY (worker_id, woke_at),
  KEY host_sleeps_woke (woke_at),
  KEY host_sleeps_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
