// Design learnings (design 07-design-learnings): one `controller_design_learnings` row per owner correction to a UI
// change (a `/revise` or `/reject` with words, an explicit `changes` verdict, a design-system review finding) and per
// supersede line. `capture_key` is unique (the item and the comment, verdict or finding), so a retried capture stores
// nothing more. `kind` is set once by the improve run's tagging call; `batch` once, by the improve run whose commit
// appends the row to design-system/learnings.md; `superseded_by` once, by the supersede line naming the row. Additive:
// a new table and its index, no backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLE = "controller_design_learnings";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key    TEXT NOT NULL,
    work_item_id   TEXT NOT NULL,
    capture_key    TEXT NOT NULL UNIQUE,
    source         TEXT NOT NULL,
    built          TEXT NOT NULL,
    words          TEXT NOT NULL,
    page           TEXT NOT NULL,
    kind           TEXT,
    at             TEXT NOT NULL,
    supersedes     TEXT,
    superseded_by  TEXT,
    batch          TEXT,
    created_at     TEXT NOT NULL
  )`);
    await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_project ON ${TABLE} (project_key, seq)`);
  },
});
