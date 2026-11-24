// Skill versions (design 11-plugin-import, 2026-11-24): one `ext_skill_versions` row per version of an imported skill
// (`ext_skill_refs` kind `skill`). `ref_id` is the ref's ID, `version` counts from 1, `folder_hash` is the skill
// folder's version (capabilities skillVersion, as eval runs store it), `text` the full SKILL.md text, `source` the
// ref's source label. Unique on (`ref_id`, `version`), so two workers importing the same change write one row. An
// import adds the next version only when the folder hash changed. Additive: a new table only, no backfill (a ref stored
// before it gets version 1 on its next import), safe to rerun. Named T1001: T1000 is the controller's of the same day.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_skill_versions";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    ref_id       TEXT NOT NULL,
    version      INTEGER NOT NULL,
    folder_hash  TEXT NOT NULL,
    text         TEXT NOT NULL,
    source       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (ref_id, version)
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
