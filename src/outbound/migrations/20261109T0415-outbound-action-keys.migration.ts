// RFC 0015 M7, keyed intents: an action may carry an `intent_key`, unique when set, so a producer that records the
// same action again (a step re-run after a restart, a retried tick) stores nothing new (§5.2). Older rows and
// actions with no key keep NULL. Additive: one nullable column and its unique index, safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "outbound_actions")).includes("intent_key")) {
      await db.run("ALTER TABLE outbound_actions ADD COLUMN intent_key TEXT");
    }
    await db.run("CREATE UNIQUE INDEX IF NOT EXISTS outbound_actions_key ON outbound_actions (intent_key)");
  },
});
