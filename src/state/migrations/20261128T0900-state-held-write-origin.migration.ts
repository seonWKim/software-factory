// The held write's origin (design 08-permissions, phase 4 of local-task-tk_cad55672): `controller_held_writes.write_origin`,
// who wrote the held write, `agent` (the gate holds only agent writes; a typed command is never held). Additive: one
// nullable TEXT column with a check, no backfill (a row held before reads NULL). The column check makes a rerun change nothing.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const TABLE = "controller_held_writes";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    if ((await tableColumns(db, TABLE)).includes("write_origin")) return;
    await db.run(`ALTER TABLE ${TABLE} ADD COLUMN write_origin TEXT CHECK (write_origin IN ('agent'))`);
  },
});
