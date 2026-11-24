// Alarm dismissal (design 05-alarms, 2026-11-24): `controller_alert_patterns` gains `dismissed_at` (when the owner
// last dismissed the pattern) and `dismissed_by` (the factory user's ID, never a display name). A dismissal at or
// after the pattern's last alert hides its alarm and lifts its dedupe window. Additive: two nullable columns, no
// backfill (no stored alarm is dismissed), safe to rerun.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const COLUMNS: readonly (readonly [column: string, type: string])[] = [
  ["dismissed_at", "TEXT"],
  ["dismissed_by", "TEXT"],
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const [column, type] of COLUMNS) {
      if (!(await tableColumns(db, "controller_alert_patterns")).includes(column)) {
        await db.run(`ALTER TABLE controller_alert_patterns ADD COLUMN ${column} ${type}`);
      }
    }
  },
});
