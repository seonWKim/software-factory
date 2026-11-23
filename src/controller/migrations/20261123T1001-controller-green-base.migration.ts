// The last green base (design 03-risk, red-main revert, 2026-11-23): `controller_green_bases`, one row per project with
// the base tip its last red-main check passed on and when. The revert of a bad automatic merge needs it: only a merge
// onto a base stored green is reverted. Additive: one new table, no backfill (a merge made before this change finds no
// green base and is not reverted), safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_green_bases"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_green_bases (
    project     TEXT PRIMARY KEY,
    base_sha    TEXT NOT NULL,
    checked_at  TEXT NOT NULL
  )`);
  },
});
