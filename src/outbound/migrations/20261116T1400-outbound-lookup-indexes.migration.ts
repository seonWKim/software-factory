// Two lookups that scanned whole tables (design 08-retention, Indexes): getBasePush reads an item's newest push_base
// action (outbound_actions by work_item_id, action, newest seq), and a reaction finds its posted comment
// (outbound_deliveries by comment_id). Additive: two indexes, no rows changed, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run("CREATE INDEX IF NOT EXISTS outbound_actions_item ON outbound_actions (work_item_id, action, seq)");
    await db.run("CREATE INDEX IF NOT EXISTS outbound_deliveries_comment ON outbound_deliveries (comment_id)");
  },
});
