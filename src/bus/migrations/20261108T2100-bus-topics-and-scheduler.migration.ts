// RFC 0015 M3: the sql bus's own tables. bus_topics lists every topic whose tables exist (they are created
// from the discovered topic descriptors, see plugins/sql/ddl.ts). bus_scheduler holds the release horizon:
// the `now` of the retry scheduler's latest tick, before which retries, delayed messages and leases are due.

import { defineMigration } from "../../state/index.js";
import { SCHEDULER_TABLE, busTablesSql, insertOrSkip } from "../plugins/sql/ddl.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of busTablesSql(db.dialect)) await db.run(sql);
    await db.run(insertOrSkip(db.dialect, `${SCHEDULER_TABLE} (id, released_until) VALUES (1, '1970-01-01T00:00:00.000Z')`));
  },
});
