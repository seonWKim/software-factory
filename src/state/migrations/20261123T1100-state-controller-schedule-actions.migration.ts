// Schedule actions (design 08-schedules, 2026-11-23): what a fired occurrence does and what it cost.
// `controller_schedules`: `action_kind` (build, agent or feedback; null: no action), `action_settings` (JSON text, the
// kind's settings) and `token_cap` (null: the default, 200000 tokens over all its runs). `controller_schedule_runs`:
// `output` (the action's result as text, egress-scanned), `tokens` and `cost_usd` (what its model calls used; null
// for an action that calls none). Additive: six nullable columns, no backfill (a stored schedule has no action and
// so runs nothing), safe to rerun.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
  ["controller_schedules", "action_kind", "TEXT"],
  ["controller_schedules", "action_settings", "TEXT"],
  ["controller_schedules", "token_cap", "INTEGER"],
  ["controller_schedule_runs", "output", "TEXT"],
  ["controller_schedule_runs", "tokens", "INTEGER"],
  ["controller_schedule_runs", "cost_usd", "REAL"],
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const [table, column, type] of COLUMNS) {
      if (!(await tableColumns(db, table)).includes(column)) await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  },
});
