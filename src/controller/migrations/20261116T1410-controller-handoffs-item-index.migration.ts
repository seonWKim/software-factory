// An item's handoffs were read by scanning the whole table (design 08-retention, Indexes): the index on
// (work_item_id, at) serves the read by item in time order. Additive: one index, no rows changed, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run("CREATE INDEX IF NOT EXISTS controller_handoffs_item ON controller_handoffs (work_item_id, at)");
  },
});
