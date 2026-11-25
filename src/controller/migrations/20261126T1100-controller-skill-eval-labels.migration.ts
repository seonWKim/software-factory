// The owner's labels on the judge (design 06-measurement, judge labels): `controller_skill_eval_labels`, one row per
// run, case, replay number (0 for a replay stored with none) and check, holding the owner's verdict on the judge's
// answer to that check (`right` or `wrong`) and the owner's user ID. The primary key keeps the first label of a check.
// Additive: a new table, no label or split backfilled, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_skill_eval_labels"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_eval_labels (
    run_id      TEXT NOT NULL,
    case_id     TEXT NOT NULL,
    replay      INTEGER NOT NULL,
    check_text  TEXT NOT NULL,
    verdict     TEXT NOT NULL CHECK (verdict IN ('right', 'wrong')),
    owner_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, replay, check_text)
  )`);
  },
});
