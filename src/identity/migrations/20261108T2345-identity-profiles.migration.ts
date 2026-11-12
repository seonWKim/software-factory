// A person's display name, stored once against their user id (owner decision 2026-11-08). Every other table
// keeps ids only; the CLI and the UI look a name up here at the edge. A table of its own, not a column on
// identity_local_users: that table lists local role holders (a row means a role; `users remove` deletes it), while
// a profile also exists for a person with no role yet and for enterprise users (github:, oidc:) who have no local
// row. Additive: a new table only, safe to rerun.

import { defineMigration } from "../../state/index.js";

const CREATE = `CREATE TABLE IF NOT EXISTS identity_profiles (
    user_id       TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    source        TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run(CREATE);
  },
});
