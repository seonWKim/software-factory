// Replay numbers (design 06-measurement, repeats, 2026-11-25): `controller_skill_eval_replays` gains a nullable
// `replay` (1 to N, `eval run --replays N`) and its key becomes run, case and replay number (none counts as 0), so a run
// stores N verdicts per case. SQLite cannot change a primary key in place, so the table is rebuilt: built as
// `controller_skill_eval_replays_next`, every row copied with no replay number (no backfill) and verified, then the old
// table is renamed to `legacy_controller_skill_eval_replays` (dropped by the legacy contract, 20261109T0900) and the
// new one takes its name. A rerun finds the legacy table and changes nothing. This runs inside the migration transaction.

import { defineMigration, LEGACY_PREFIX, tableColumns, tableExists, verifyCopy } from "../../state/index.js";

const TABLE = "controller_skill_eval_replays";
const NEXT = `${TABLE}_next`;
const LEGACY = `${LEGACY_PREFIX}${TABLE}`;
const KEY = `${TABLE}_key`;

const BUILD = `CREATE TABLE IF NOT EXISTS ${NEXT} (
    run_id        TEXT NOT NULL,
    case_id       TEXT NOT NULL,
    verdict       TEXT NOT NULL,
    detail        TEXT NOT NULL,
    recorded_at   TEXT NOT NULL,
    transcript    TEXT,
    answer        TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_usd      REAL,
    wall_ms       INTEGER,
    replay        INTEGER
  )`;

export default defineMigration({
  change: "breaking",
  tables: [TABLE],
  async up(db) {
    if (await tableExists(db, LEGACY)) return;
    await db.run(BUILD);
    await db.run(`DELETE FROM ${NEXT}`); // half-filled by an interrupted run
    const cols = await tableColumns(db, TABLE);
    const list = cols.join(", ");
    await db.run(`INSERT INTO ${NEXT} (${list}) SELECT ${list} FROM ${TABLE}`);
    const problems = await verifyCopy(db, TABLE, NEXT, cols);
    if (problems.length > 0) throw new Error(`copy of ${TABLE} failed verification: ${problems.join("; ")}`);
    await db.run(`ALTER TABLE ${TABLE} RENAME TO ${LEGACY}`);
    await db.run(`ALTER TABLE ${NEXT} RENAME TO ${TABLE}`);
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${KEY} ON ${TABLE} (run_id, case_id, COALESCE(replay, 0))`);
  },
  async verify(db) {
    const out: string[] = [];
    if (!(await tableColumns(db, TABLE)).includes("replay")) out.push(`${TABLE} has no replay`);
    if ((await db.all(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = '${KEY}' AND tbl_name = '${TABLE}'`)).length === 0) out.push(`${KEY} is not on ${TABLE}`);
    const kept = (await tableColumns(db, LEGACY)).join(", ");
    const [lost] = await db.all(`SELECT COUNT(*) AS n FROM (SELECT ${kept} FROM ${LEGACY} EXCEPT SELECT ${kept} FROM ${TABLE} WHERE replay IS NULL)`);
    if (Number(lost?.n) > 0) out.push(`${Number(lost?.n)} replays of ${LEGACY} are missing or changed in ${TABLE}`);
    return out;
  },
});
