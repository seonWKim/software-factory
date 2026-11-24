// Routines copied into Check a page schedules (design 08-schedules, 2026-11-24): nine nullable columns on
// `controller_schedules` with the same names as on `controller_routines` (instruction, url, paused, the USD caps and
// cap marks, last_run_at), and `controller_schedule_suggestions`, shaped like `controller_routine_suggestions` with
// schedule_id in place of routine_id. Each routine with a cadence is copied to a schedule with the same ID (its name
// as title, action_kind 'check_page'), and its suggestions with the same IDs. Trigger routines have no cadence and
// are not copied. The routine tables are kept and still read by the routine store. Additive: INSERT OR IGNORE, so a
// rerun changes nothing and never overwrites a copy.

import { defineMigration, tableColumns } from "../../state/index.js";

const COLUMNS: readonly (readonly [string, string])[] = [
  ["instruction", "TEXT"], ["url", "TEXT"], ["paused", "INTEGER"], ["run_cap_usd", "REAL"], ["daily_cap_usd", "REAL"],
  ["cap_raise_usd", "REAL"], ["cap_raise_day", "TEXT"], ["cap_hold_key", "TEXT"], ["last_run_at", "TEXT"],
];
const ROUTINE_FIELDS = COLUMNS.map(([c]) => c).join(", ");
const SUGGESTION_FIELDS = "run_id, fingerprint, text, state, duplicates, last_run_id, snoozed_until, filed_ref, decided_by, decided_at, created_at";

export default defineMigration({
  change: "additive",
  tables: ["controller_schedules", "controller_schedule_suggestions"],
  async up(db) {
    const have = await tableColumns(db, "controller_schedules");
    for (const [name, type] of COLUMNS) if (!have.includes(name)) await db.run(`ALTER TABLE controller_schedules ADD COLUMN ${name} ${type}`);
    await db.run(`CREATE TABLE IF NOT EXISTS controller_schedule_suggestions (
    id             TEXT PRIMARY KEY,
    schedule_id    TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    text           TEXT NOT NULL,
    state          TEXT NOT NULL,
    duplicates     INTEGER NOT NULL,
    last_run_id    TEXT NOT NULL,
    snoozed_until  TEXT,
    filed_ref      TEXT,
    decided_by     TEXT,
    decided_at     TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE (schedule_id, fingerprint)
  )`);
    await db.run(`INSERT OR IGNORE INTO controller_schedules
    (id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since, action_kind, ${ROUTINE_FIELDS})
    SELECT id, name, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, NULL, 'check_page', ${ROUTINE_FIELDS}
    FROM controller_routines WHERE cadence_kind IS NOT NULL AND cadence_spec IS NOT NULL`);
    await db.run(`INSERT OR IGNORE INTO controller_schedule_suggestions (id, schedule_id, ${SUGGESTION_FIELDS})
    SELECT id, routine_id, ${SUGGESTION_FIELDS} FROM controller_routine_suggestions
    WHERE routine_id IN (SELECT id FROM controller_routines WHERE cadence_kind IS NOT NULL AND cadence_spec IS NOT NULL)`);
  },
});
