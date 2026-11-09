// Issue #461: runtime_child_restarts.recorded_at was written on every insert and never read; the restart history
// reads only `at` and `reason` (design 05-restarts). Breaking: code from before this change still writes the column,
// so on a shared MySQL store the writers are drained first (npm run migrate does), and the runner archives the
// table to the backup folder before `up` (RFC 0015 §12 D1).
//
// `up` takes the checksum of every row's restart_key, at and reason just before the drop, the same rows the
// runner archived; `verify` fails when any of them changed or the column is still there (§12 D2).
//
// MySQL DDL is not transactional: the column is looked up first, so a rerun after the drop finishes cleanly.

import { defineMigration, tableChecksum, tableColumns, type MigrationDb, type TableSummary } from "../../state/index.js";

const TABLE = "runtime_child_restarts";
const COLUMN = "recorded_at";
const KEPT = ["restart_key", "at", "reason"];

/** The kept columns' checksum before the drop, per database handle the runner passes to up and then verify. */
const before = new WeakMap<MigrationDb, TableSummary>();

const hasColumn = async (db: MigrationDb): Promise<boolean> => (await tableColumns(db, TABLE)).includes(COLUMN);

export default defineMigration({
  change: "breaking",
  tables: [TABLE],
  async up(db) {
    if (!(await hasColumn(db))) return;
    before.set(db, await tableChecksum(db, TABLE, KEPT));
    await db.run(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  },
  async verify(db) {
    if (await hasColumn(db)) return [`${TABLE}.${COLUMN} is still there`];
    const was = before.get(db);
    if (was === undefined) return []; // dropped by an earlier, interrupted run: no checksum from before to compare
    const now = await tableChecksum(db, TABLE, KEPT);
    if (now.rows !== was.rows) return [`${TABLE} has ${now.rows} rows, had ${was.rows} before the drop`];
    if (now.checksum !== was.checksum) return [`${TABLE} differs over ${KEPT.join(", ")} from before the drop (checksum ${now.checksum} vs ${was.checksum})`];
    return [];
  },
});
