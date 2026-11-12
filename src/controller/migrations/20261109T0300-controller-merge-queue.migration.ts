// RFC 0015 M8: the merge queue's snapshots. One `controller_merge_queues` row per project and base branch (the
// MergeQueue actor), and its entries in `controller_merge_queue_entries` (in queue order by `seq`). Additive: new
// tables only, safe to rerun. Ids only: work item ids and user ids, never a display name.

import { defineMigration } from "../../state/index.js";

const TABLES = [
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

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
