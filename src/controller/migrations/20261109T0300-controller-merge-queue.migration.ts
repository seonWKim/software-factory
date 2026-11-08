// RFC 0015 M8: the merge queue's snapshots. One `controller_merge_queues` row per project and base branch (the
// MergeQueue actor), and its entries in `controller_merge_queue_entries` (in queue order by `seq`). Additive: new
// tables only, safe to rerun. Ids only: work item ids and user ids, never a display name.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS controller_merge_queues (
    queue_id     TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    base_ref     TEXT NOT NULL,
    state        TEXT NOT NULL,
    version      INTEGER NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS controller_merge_queue_entries (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id      TEXT NOT NULL UNIQUE,
    queue_id      TEXT NOT NULL,
    work_item_id  TEXT NOT NULL,
    state         TEXT NOT NULL,
    entered_by    TEXT NOT NULL,
    merge_key     TEXT NOT NULL,
    detail        TEXT NOT NULL,
    run_key       TEXT,
    base_sha      TEXT,
    reason        TEXT,
    version       INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS controller_merge_queue_entries_queue ON controller_merge_queue_entries (queue_id, state, seq)",
  "CREATE INDEX IF NOT EXISTS controller_merge_queue_entries_item ON controller_merge_queue_entries (work_item_id, state)",
];

// Indexes inline, so each statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS controller_merge_queues (
    queue_id     VARCHAR(191) NOT NULL PRIMARY KEY,
    project_id   VARCHAR(191) NOT NULL,
    base_ref     VARCHAR(191) NOT NULL,
    state        VARCHAR(16) NOT NULL,
    version      BIGINT NOT NULL,
    updated_at   CHAR(24) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS controller_merge_queue_entries (
    seq           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    entry_id      VARCHAR(191) NOT NULL,
    queue_id      VARCHAR(191) NOT NULL,
    work_item_id  VARCHAR(191) NOT NULL,
    state         VARCHAR(16) NOT NULL,
    entered_by    VARCHAR(191) NOT NULL,
    merge_key     VARCHAR(191) NOT NULL,
    detail        TEXT NOT NULL,
    run_key       VARCHAR(191) NULL,
    base_sha      VARCHAR(64) NULL,
    reason        TEXT NULL,
    version       BIGINT NOT NULL,
    created_at    CHAR(24) NOT NULL,
    updated_at    CHAR(24) NOT NULL,
    UNIQUE KEY controller_merge_queue_entries_entry (entry_id),
    KEY controller_merge_queue_entries_queue (queue_id, state, seq),
    KEY controller_merge_queue_entries_item (work_item_id, state)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
