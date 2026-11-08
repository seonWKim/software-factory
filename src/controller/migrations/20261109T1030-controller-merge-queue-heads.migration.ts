// RFC 0015 M8, the merge queue's review fixes: each entry keeps the branch heads its green check merged (`heads`,
// JSON branch → sha), so the landing merges only the commits that were checked; and `run_key` is indexed, so a
// merge-check result finds its entry without a scan. Additive: one nullable column and one index, safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_merge_queue_entries")).includes("heads")) {
      await db.run(
        db.dialect === "mysql"
          ? "ALTER TABLE controller_merge_queue_entries ADD COLUMN heads TEXT NULL, ADD KEY controller_merge_queue_entries_run (run_key)"
          : "ALTER TABLE controller_merge_queue_entries ADD COLUMN heads TEXT",
      );
    }
    if (db.dialect === "sqlite") await db.run("CREATE INDEX IF NOT EXISTS controller_merge_queue_entries_run ON controller_merge_queue_entries (run_key)");
  },
});
