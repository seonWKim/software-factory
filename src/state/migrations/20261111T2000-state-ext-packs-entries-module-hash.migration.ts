// Pack tool modules pinned (design 11-packs): `module_hash` on `ext_packs_entries` is the SHA-256 of the tool's
// `tools/<file>.tool.js` bytes as `factory pack add` read them; null for a tool with no module and for an MCP server.
// The entry's description_hash covers the module too. Additive: one nullable column, no backfill (a stored row's
// module is unknown), safe to rerun.

import { tableColumns } from "../migrate/copy-tables.js";
import { defineMigration } from "../migrate/migration.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if ((await tableColumns(db, "ext_packs_entries")).includes("module_hash")) return;
    await db.run(`ALTER TABLE ext_packs_entries ADD COLUMN module_hash TEXT`);
  },
});
