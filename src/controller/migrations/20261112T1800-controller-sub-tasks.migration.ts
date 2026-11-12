// Sub-tasks (design 02-tasks): `parent_task_id` on `controller_tasks`, the task a sub-task belongs to (one level),
// indexed so a delete finds a task's sub-tasks without a scan. Not `parent_id`, which names the task a recurring
// occurrence came from and is unique. Additive: one nullable column and one index, no backfill (existing tasks stay
// top-level), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_tasks")).includes("parent_task_id")) {
      await db.run("ALTER TABLE controller_tasks ADD COLUMN parent_task_id TEXT");
    }
    await db.run("CREATE INDEX IF NOT EXISTS controller_tasks_sub_tasks ON controller_tasks (parent_task_id)");
  },
});
