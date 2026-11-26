// Permission modes, phase 1 (design 08-permissions, 2026-11-27): two nullable TEXT columns on `inbound_commands`.
// `write_origin` is who wrote the command (`human_command` or `agent`); `origin` already names the channel (cli, app,
// github). `permission_mode` is the mode in force when the command was taken, written by the gate of a later phase.
// Additive, with no backfill: existing rows keep NULL in both. The column check makes a rerun change nothing.

import { defineMigration, tableColumns } from "../../state/index.js";

const TABLE = "inbound_commands";
const COLUMNS = ["write_origin", "permission_mode"] as const;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    const have = await tableColumns(db, TABLE);
    for (const column of COLUMNS) {
      if (!have.includes(column)) await db.run(`ALTER TABLE ${TABLE} ADD COLUMN ${column} TEXT`);
    }
  },
});
