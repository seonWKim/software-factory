// Routine rows on the schedule tables (design 08-schedules, 2026-11-25): `controller_schedules` gains a nullable
// `trigger_kind` and its `cadence_kind` and `cadence_spec` become nullable, so a trigger routine (no cadence) can be
// stored there. SQLite cannot drop a NOT NULL, so the table is rebuilt: built as `controller_schedules_next`, every
// row copied and verified, then the old table is renamed to `legacy_controller_schedules` (dropped by the legacy
// contract, 20261109T0900) and the new one takes its name and the due index.
//
// In the same pass the Check a page rows are made to match the routine tables at the switch: the step-1 copies
// (20261124T1100) and their suggestions are replaced by every routine, trigger routines included, and its
// suggestions, with the same IDs. From here the routine store reads and writes only the schedule tables; the routine
// tables stay, unused, until a later contract. A rerun finds the legacy table and changes nothing.
//
// This runs inside the migration transaction.

import { defineMigration, LEGACY_PREFIX, tableColumns, tableExists, verifyCopy, type MigrationDb } from "../../state/index.js";

const TABLE = "controller_schedules";
const NEXT = `${TABLE}_next`;
const LEGACY = `${LEGACY_PREFIX}${TABLE}`;
const CHECK_PAGE = "action_kind = 'check_page'";

/** The routine columns a Check a page row carries under the same name. */
const ROUTINE_FIELDS = "instruction, url, cadence_kind, cadence_spec, zone, trigger_kind, run_cap_usd, daily_cap_usd, cap_raise_usd, cap_raise_day, cap_hold_key, paused, created_by, created_at, next_due_at, last_run_at";
const SUGGESTION_FIELDS = "run_id, fingerprint, text, state, duplicates, last_run_id, snoozed_until, filed_ref, decided_by, decided_at, created_at";

const BUILD = `CREATE TABLE IF NOT EXISTS ${NEXT} (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    cadence_kind     TEXT,
    cadence_spec     TEXT,
    zone             TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    next_due_at      TEXT,
    running_since    TEXT,
    skip_when_busy   INTEGER,
    action_kind      TEXT,
    action_settings  TEXT,
    token_cap        INTEGER,
    instruction      TEXT,
    url              TEXT,
    paused           INTEGER,
    run_cap_usd      REAL,
    daily_cap_usd    REAL,
    cap_raise_usd    REAL,
    cap_raise_day    TEXT,
    cap_hold_key     TEXT,
    last_run_at      TEXT,
    trigger_kind     TEXT
  )`;

/** Builds the new table and fills it with every row of the old one over the old one's columns, verified. */
async function rebuild(db: MigrationDb): Promise<void> {
  await db.run(BUILD);
  await db.run(`DELETE FROM ${NEXT}`); // half-filled by an interrupted run
  const cols = await tableColumns(db, TABLE);
  const list = cols.join(", ");
  await db.run(`INSERT INTO ${NEXT} (${list}) SELECT ${list} FROM ${TABLE}`);
  const problems = await verifyCopy(db, TABLE, NEXT, cols);
  if (problems.length > 0) throw new Error(`copy of ${TABLE} failed verification: ${problems.join("; ")}`);
  await db.run(`ALTER TABLE ${TABLE} RENAME TO ${LEGACY}`);
  await db.run(`ALTER TABLE ${NEXT} RENAME TO ${TABLE}`);
  // The index followed the old table under its old name; the due list reads it on the new one.
  await db.run(`DROP INDEX IF EXISTS ${TABLE}_due`);
  await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_due ON ${TABLE} (next_due_at)`);
}

/** Replaces the Check a page rows and their suggestions with every routine and its suggestions, same IDs. */
async function refreshCopies(db: MigrationDb): Promise<void> {
  await db.run(`DELETE FROM controller_schedule_suggestions WHERE schedule_id IN (SELECT id FROM ${TABLE} WHERE ${CHECK_PAGE})`);
  await db.run(`DELETE FROM ${TABLE} WHERE ${CHECK_PAGE}`);
  await db.run(`INSERT OR IGNORE INTO ${TABLE} (id, title, action_kind, ${ROUTINE_FIELDS})
    SELECT id, name, 'check_page', ${ROUTINE_FIELDS} FROM controller_routines`);
  await db.run(`INSERT OR IGNORE INTO controller_schedule_suggestions (id, schedule_id, ${SUGGESTION_FIELDS})
    SELECT id, routine_id, ${SUGGESTION_FIELDS} FROM controller_routine_suggestions
    WHERE routine_id IN (SELECT id FROM ${TABLE} WHERE ${CHECK_PAGE})`);
}

export default defineMigration({
  change: "breaking",
  tables: [TABLE, "controller_schedule_suggestions"],
  async up(db) {
    if (await tableExists(db, LEGACY)) return;
    await rebuild(db);
    await refreshCopies(db);
  },
  async verify(db) {
    const out: string[] = [];
    const info = await db.all(`SELECT name, "notnull" AS nn FROM pragma_table_info('${TABLE}')`);
    const col = (name: string) => info.find((r) => r.name === name);
    if (!col("trigger_kind")) out.push(`${TABLE} has no trigger_kind`);
    for (const c of ["cadence_kind", "cadence_spec"]) if (Number(col(c)?.nn) !== 0) out.push(`${TABLE}.${c} is still NOT NULL`);
    if ((await db.all(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = '${TABLE}_due' AND tbl_name = '${TABLE}'`)).length === 0) out.push(`${TABLE}_due is not on ${TABLE}`);
    const kept = (await tableColumns(db, LEGACY)).join(", ");
    const [lost] = await db.all(`SELECT COUNT(*) AS n FROM (SELECT ${kept} FROM ${LEGACY} WHERE NOT COALESCE(${CHECK_PAGE}, 0) EXCEPT SELECT ${kept} FROM ${TABLE})`);
    if (Number(lost?.n) > 0) out.push(`${Number(lost?.n)} schedules of ${LEGACY} are missing or changed in ${TABLE}`);
    const [off] = await db.all(`SELECT COUNT(*) AS n FROM controller_routines WHERE id NOT IN (SELECT id FROM ${TABLE} WHERE ${CHECK_PAGE})`);
    if (Number(off?.n) > 0) out.push(`${Number(off?.n)} routines have no Check a page row`);
    return out;
  },
});
