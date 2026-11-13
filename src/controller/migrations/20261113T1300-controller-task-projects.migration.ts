// Task projects (phase 1 of 3; src/core/projects.ts): one `controller_projects` row per project, its `slug` unique
// across active and archived ones, `archived_at` set while it is archived; and `controller_task_projects`, one row
// per task in a project, so a task may be in several. `created_by` is a user ID, never a display name. Additive: two
// new tables and one index, no rows written (no task is backfilled into a project), safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS controller_projects (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    archived_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS controller_task_projects (
    task_id     TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    added_at    TEXT NOT NULL,
    PRIMARY KEY (task_id, project_id)
  )`,
  "CREATE INDEX IF NOT EXISTS controller_task_projects_project ON controller_task_projects (project_id)",
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
