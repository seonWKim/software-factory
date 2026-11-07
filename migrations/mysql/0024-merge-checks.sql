-- Merge checks (issue #248, design §5 Merge check): the same table as SQLite migration 24. One row per item, its
-- latest local merge check against the base. `mergeable` is 0 or 1; `conflicts` is JSON text (the conflicting paths).
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS merge_checks (
  work_item_id  VARCHAR(64) NOT NULL PRIMARY KEY,
  mergeable     TINYINT NOT NULL,
  conflicts     MEDIUMTEXT NOT NULL,
  head_sha      VARCHAR(64) NOT NULL,
  base_sha      VARCHAR(64) NOT NULL,
  checked_at    CHAR(24) NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
