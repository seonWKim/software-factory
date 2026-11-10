// The signal ledger (design 11-signal-ledger, issue #491): one `controller_signals` row per stored signal (a gate
// decision, a revision or retry request, a verdict, a review finding, a failed run, a revert or fix-forward), keyed
// on its source record (source, source_ref) so a rerun or a second replica writes nothing twice. IDs, enum codes and
// times only: no text, no display name. Additive: a new table only, safe to rerun.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS controller_signals (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    source_ref    TEXT NOT NULL,
    kind          TEXT NOT NULL,
    work_item_id  TEXT NOT NULL,
    role          TEXT,
    rule          TEXT,
    at            TEXT NOT NULL,
    UNIQUE (source, source_ref)
  )`,
  "CREATE INDEX IF NOT EXISTS controller_signals_source_at ON controller_signals (source, at)",
  "CREATE INDEX IF NOT EXISTS controller_signals_item ON controller_signals (work_item_id, at)",
];

// Indexes inline, so the statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS controller_signals (
    id            VARCHAR(191) NOT NULL PRIMARY KEY,
    source        VARCHAR(64) NOT NULL,
    source_ref    VARCHAR(191) NOT NULL,
    kind          VARCHAR(64) NOT NULL,
    work_item_id  VARCHAR(191) NOT NULL,
    role          VARCHAR(64) NULL,
    rule          VARCHAR(64) NULL,
    at            CHAR(24) NOT NULL,
    UNIQUE KEY controller_signals_ref (source, source_ref),
    KEY controller_signals_source_at (source, at),
    KEY controller_signals_item (work_item_id, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
