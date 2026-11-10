// Whether a filed pattern's fix held (design 07-self-improvement, issue #511): `outcome` (`holds` or `regressed`)
// and `outcome_at` on `controller_filed_patterns`, set once seven days after the fix item closed as completed.
// Additive: two nullable columns, no backfill (existing rows keep no outcome), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const columns = await tableColumns(db, "controller_filed_patterns");
    if (!columns.includes("outcome")) {
      await db.run(`ALTER TABLE controller_filed_patterns ADD COLUMN outcome ${db.dialect === "mysql" ? "VARCHAR(16) NULL" : "TEXT"}`);
    }
    if (!columns.includes("outcome_at")) {
      await db.run(`ALTER TABLE controller_filed_patterns ADD COLUMN outcome_at ${db.dialect === "mysql" ? "CHAR(24) NULL" : "TEXT"}`);
    }
  },
});
