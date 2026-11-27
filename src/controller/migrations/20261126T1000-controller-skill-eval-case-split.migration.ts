// The split of a skill eval case (design 07-self-improvement): `controller_skill_eval_cases.split`, `dev` (a case a
// draft is tuned and measured on) or `held-out` (a case only the promotion check replays). Additive: one TEXT NOT NULL
// column defaulting to `dev`, no backfill (every stored case reads `dev`). The column check makes a rerun change nothing.

import { defineMigration, tableColumns } from "../../state/index.js";

const TABLE = "controller_skill_eval_cases";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    if ((await tableColumns(db, TABLE)).includes("split")) return;
    await db.run(`ALTER TABLE ${TABLE} ADD COLUMN split TEXT NOT NULL DEFAULT 'dev' CHECK (split IN ('dev', 'held-out'))`);
  },
});
