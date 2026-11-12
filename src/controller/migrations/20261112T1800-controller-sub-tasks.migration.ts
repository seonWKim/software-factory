// Sub-tasks (design 02-tasks): `parent_task_id` on `controller_tasks`, the task a sub-task belongs to (one level),
// indexed so a delete finds a task's sub-tasks without a scan. Not `parent_id`, which names the task a recurring
// occurrence came from and is unique. Additive: one nullable column and one index, no backfill (existing tasks stay
// top-level), safe to rerun. TEXT on SQLite; VARCHAR(191) NULL on MySQL, the width of a task ID (`id`), so it can be indexed.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_tasks")).includes("parent_task_id")) {
      await db.run(
        db.dialect === "mysql"
          ? "ALTER TABLE controller_tasks ADD COLUMN parent_task_id VARCHAR(191) NULL, ADD KEY controller_tasks_sub_tasks (parent_task_id)"
          : "ALTER TABLE controller_tasks ADD COLUMN parent_task_id TEXT",
      );
    }
    if (db.dialect === "sqlite") await db.run("CREATE INDEX IF NOT EXISTS controller_tasks_sub_tasks ON controller_tasks (parent_task_id)");
  },
});
