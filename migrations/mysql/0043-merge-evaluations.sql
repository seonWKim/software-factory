-- Per-merge evaluations (design 06-measurement): the same table as SQLite migration 42. One row per merge, keyed by
-- (work_item_id, merge_sha), inserted by the merge's own transition only when none is stored, so a second run or
-- another replica inserts nothing. No backfill: merges before this step get no row.
-- Safe to rerun: the table is created only when missing, and its keys are part of it.

CREATE TABLE IF NOT EXISTS controller_merge_evaluations (
  work_item_id  VARCHAR(64) NOT NULL,
  merge_sha     VARCHAR(64) NOT NULL,
  tier          TINYINT NULL,
  merged_by     VARCHAR(128) NOT NULL,
  token_cost    BIGINT NOT NULL,
  merged_at     CHAR(24) NOT NULL,
  PRIMARY KEY (work_item_id, merge_sha),
  KEY controller_merge_evaluations_at (merged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
