// Schedule a task (design 02-tasks): `duration_minutes` on `controller_tasks`, how long the task takes (null: the
// 30-minute default when it is planned), and `reminded_at`, the sent-marker of the reminder at the task's time,
// written once by a conditional update. SQLite only: the MySQL store is gone. Additive: two nullable columns, no
// backfill (an existing task keeps the default and gets its reminder at its next time), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

const COLUMNS = [
  ["duration_minutes", "INTEGER"],
  ["reminded_at", "TEXT"],
] as const;

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const have = await tableColumns(db, "controller_tasks");
    for (const [name, type] of COLUMNS) {
      if (!have.includes(name)) await db.run(`ALTER TABLE controller_tasks ADD COLUMN ${name} ${type}`);
    }
  },
});
