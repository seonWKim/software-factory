// Rejected filings (design 07-self-improvement, issue #775): `evidence` on `controller_filed_patterns`, the pattern's
// count when it was filed (runs, plus held items for a hot file), so a rejected pattern is filed again only when its
// evidence at least doubles, or 30 days after the close. Additive: one nullable column, no backfill (rows filed
// before keep null and wait the 30 days, as before), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_filed_patterns")).includes("evidence")) await db.run("ALTER TABLE controller_filed_patterns ADD COLUMN evidence INTEGER");
  },
});
