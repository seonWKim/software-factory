// Plain tasks (design 02-tasks, issue #606): one `controller_tasks` row per task, kept apart from the work items so
// triage never reads one. `list` is a free label, never a repository key; `created_by` a user ID, never a display
// name. A recurring task's next occurrence names it in `parent_id`, unique, so completing it twice inserts one
// occurrence. Additive: a new table only, safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLES = [
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

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
