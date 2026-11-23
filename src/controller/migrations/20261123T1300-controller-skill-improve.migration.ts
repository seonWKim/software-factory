// Skill improvement (design 07-self-improvement): `controller_skill_drafts` (one row per drafted skill change, its
// state one of tried, proposed, promoted, rejected or held; `detail` is JSON text, never a transcript) and
// `controller_skill_draft_days` (drafts taken per project and UTC day). Additive: two new tables and an index, no
// backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_skill_drafts", "controller_skill_draft_days"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_drafts (
    id           TEXT PRIMARY KEY,
    project_key  TEXT NOT NULL,
    skill_ref    TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('tried', 'proposed', 'promoted', 'rejected', 'held')),
    tokens       INTEGER NOT NULL,
    detail       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_skill_drafts_project ON controller_skill_drafts (project_key, skill_ref)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_draft_days (
    project_key  TEXT NOT NULL,
    day          TEXT NOT NULL,
    count        INTEGER NOT NULL,
    PRIMARY KEY (project_key, day)
  )`);
  },
});
