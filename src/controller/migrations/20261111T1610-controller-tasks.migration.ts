// Plain tasks (design 02-tasks, issue #606): one `controller_tasks` row per task, kept apart from the work items so
// triage never reads one. `list` is a free label, never a repository key; `created_by` a user ID, never a display
// name. A recurring task's next occurrence names it in `parent_id`, unique, so completing it twice inserts one
// occurrence. Additive: a new table only, safe to rerun.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS controller_tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    list        TEXT,
    priority    INTEGER,
    due_date    TEXT,
    due_time    TEXT,
    recurrence  TEXT,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    done_at     TEXT,
    parent_id   TEXT UNIQUE
  )`,
  "CREATE INDEX IF NOT EXISTS controller_tasks_open ON controller_tasks (done_at, created_at)",
];

// Indexes inline, so the statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS controller_tasks (
    id          VARCHAR(191) NOT NULL PRIMARY KEY,
    title       TEXT NOT NULL,
    list        VARCHAR(191) NULL,
    priority    TINYINT NULL,
    due_date    CHAR(10) NULL,
    due_time    CHAR(5) NULL,
    recurrence  VARCHAR(16) NULL,
    created_by  VARCHAR(191) NOT NULL,
    created_at  CHAR(24) NOT NULL,
    done_at     CHAR(24) NULL,
    parent_id   VARCHAR(191) NULL,
    UNIQUE KEY controller_tasks_parent (parent_id),
    KEY controller_tasks_open (done_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
