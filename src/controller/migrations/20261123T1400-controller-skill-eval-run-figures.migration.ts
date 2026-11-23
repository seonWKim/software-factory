// Skill eval run figures: `controller_skill_eval_runs.model_class`, `judge_model_class`, `replays`, `pass_rate` and
// `errored`, written once after a run finishes (src/skill-evals.ts, design 06-measurement). Additive: five nullable
// columns, no backfill (a stored run keeps null in each), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

const FIGURES: readonly (readonly [string, string])[] = [
  ["model_class", "TEXT"], ["judge_model_class", "TEXT"], ["replays", "INTEGER"], ["pass_rate", "REAL"], ["errored", "INTEGER"],
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const have = await tableColumns(db, "controller_skill_eval_runs");
    for (const [name, type] of FIGURES) if (!have.includes(name)) await db.run(`ALTER TABLE controller_skill_eval_runs ADD COLUMN ${name} ${type}`);
  },
});
