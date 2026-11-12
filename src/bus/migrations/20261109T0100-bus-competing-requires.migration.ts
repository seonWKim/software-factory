// RFC 0015 M3 leftovers: competing topics take `requires` (what a consumer must be able to do to claim a message).
// A new competing topic gets the column from its DDL; this adds it to every competing topic created before, as
// listed in bus_topics. Resumable: a table that has the column already is skipped.

import { defineMigration, tableColumns } from "../../state/index.js";
import { REQUIRES_COLUMN, TOPICS_TABLE, topicTables } from "../plugins/sql/ddl.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const row of await db.all(`SELECT name FROM ${TOPICS_TABLE} WHERE consumption = 'competing'`)) {
      const table = topicTables(String(row.name)).messages;
      if ((await tableColumns(db, table)).includes("requires")) continue;
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${REQUIRES_COLUMN}`);
    }
  },
});
