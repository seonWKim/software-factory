// Imported skill references (design 11-plugin-import): one `ext_skill_refs` row per skill file that `factory plugins
// import` found in a user-level Claude Code or Codex config. `source` claude | codex, `name` the skill's folder name,
// `path` the absolute path of its SKILL.md, `sha256` of the file's bytes (never its text), `added_by` the importer's
// user ID (never a display name), `created_at` from the Clock. A changed file is a new row (a new sha256); the same
// file again adds nothing. Additive: a new table only, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_skill_refs";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (source, path, sha256)
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
