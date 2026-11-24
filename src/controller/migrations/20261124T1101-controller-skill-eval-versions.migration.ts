// Skill eval versions (design 06-measurement): every column of "Versioned runs and compare" in one migration.
// - controller_skill_eval_runs: suite_version, judge_version, factory_version, written when a run starts.
// - controller_skill_eval_suites.version: 1 for every suite, one more on each case add, edit or delete.
// - controller_skill_eval_replays: transcript, answer, input_tokens, output_tokens, cost_usd, wall_ms.
// - controller_skill_eval_cases: seed (the case's seed folder) and mcp (its MCP servers).
// Additive: nullable columns (the suite version defaults to 1), no backfill (a stored run keeps null in each), safe to
// rerun. The stamp is the next free minute after 20261124T1100, which another migration uses.

import { defineMigration, tableColumns } from "../../state/index.js";

const COLUMNS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  controller_skill_eval_runs: [["suite_version", "INTEGER"], ["judge_version", "TEXT"], ["factory_version", "TEXT"]],
  controller_skill_eval_suites: [["version", "INTEGER NOT NULL DEFAULT 1"]],
  controller_skill_eval_replays: [
    ["transcript", "TEXT"], ["answer", "TEXT"], ["input_tokens", "INTEGER"], ["output_tokens", "INTEGER"], ["cost_usd", "REAL"], ["wall_ms", "INTEGER"],
  ],
  controller_skill_eval_cases: [["seed", "TEXT"], ["mcp", "TEXT"]],
};

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const have = await tableColumns(db, table);
      for (const [name, type] of columns) if (!have.includes(name)) await db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  },
});
