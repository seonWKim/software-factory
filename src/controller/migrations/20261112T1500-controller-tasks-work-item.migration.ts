// Build this (design 02-tasks, issue #607): `work_item_id` on `controller_tasks`, the work item `task build` made from
// the task, so a merge of that item closes the task. Additive: one nullable column, no backfill (existing tasks stay
// unlinked), safe to rerun. The same column on both dialects: TEXT on SQLite, VARCHAR(64) NULL (a work item ID's
// width in controller_work_items) on MySQL.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if ((await tableColumns(db, "controller_tasks")).includes("work_item_id")) return;
    await db.run(`ALTER TABLE controller_tasks ADD COLUMN work_item_id ${db.dialect === "mysql" ? "VARCHAR(64) NULL" : "TEXT"}`);
  },
});
