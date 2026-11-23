// Skill eval versions: `controller_skill_eval_runs.skill_version`, the SHA-256 of the skill folder a run replayed
// (src/runtime/capabilities/capabilities.ts skillVersion), so a run after the skill changed is told apart from one
// before. Additive: one nullable column, no backfill (a stored run keeps null), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_skill_eval_runs")).includes("skill_version")) await db.run("ALTER TABLE controller_skill_eval_runs ADD COLUMN skill_version TEXT");
  },
});
