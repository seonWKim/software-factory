// Tool listings of imported MCP servers (design 11-plugin-import, phase 3): one `ext_mcp_tool_lists` row per
// approved description (`name`, `description_hash`) the Plugins read asked to list. The UI writes it as `requested`
// with `requested_by` (a user ID, never a display name); a worker claims it (`running`, `claimed_by`) and ends it as
// `listed` (with `tools`, a JSON list of tool names only), `not_stdio`, `did_not_start` or `not_approved`. No tool
// description and no error text is stored. Additive: a new table only, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_mcp_tool_lists";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    description_hash  TEXT NOT NULL,
    status            TEXT NOT NULL,
    tools             TEXT,
    requested_by      TEXT NOT NULL,
    claimed_by        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (name, description_hash)
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
