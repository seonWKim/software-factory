// RFC 0015 M7, a run's push and PR: what a delivered action made, when it names one (`delivered_ref`, a PR's
// number) and its link (`delivered_url`). The controller applies them to the item on DeliveryCompleted. Older rows
// keep NULL. Additive: two nullable columns, safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const have = await tableColumns(db, "outbound_actions");
    for (const col of ["delivered_ref", "delivered_url"]) {
      if (have.includes(col)) continue;
      await db.run(`ALTER TABLE outbound_actions ADD COLUMN ${col} TEXT`);
    }
  },
});
