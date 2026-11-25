// The new-version gate of a skill (design 07-self-improvement): `controller_skill_version_gates`, one row per
// `ext_skill_versions` row recorded from now on, keyed by its ref and version. Its state is one of pending, running,
// passed, held or rejected; a running gate holds a lease token and a lease end; `detail` is JSON text. Additive: a new
// table, no backfill (a version recorded before it has no gate row and stays current), safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_skill_version_gates"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_version_gates (
    ref_id       TEXT NOT NULL,
    version      INTEGER NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('pending', 'running', 'passed', 'held', 'rejected')),
    lease_token  TEXT,
    lease_until  TEXT,
    run_id       TEXT,
    detail       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (ref_id, version)
  )`);
  },
});
