// Imported skill and command pointers, one row per file (design 11-plugin-import): `ext_skill_refs` is rebuilt unique
// on (source, path) with a `kind` column (`skill` | `command`) and an `updated_at`, so a changed file updates its row
// instead of adding one. SQLite cannot change a UNIQUE key in place, so the old table is renamed to
// `legacy_ext_skill_refs` and kept until the contract migration (20261109T0900) archives and drops it after the owner
// confirms; nothing is dropped here. Every old row is kind `skill`. Of the rows one (source, path) had (an edited file
// re-imported), the newest is kept with its ID, name, SHA-256, importer and created_at, as the skill list read it; the
// older ones stay in the legacy table. Breaking: the code reads the new key in the same release. A rerun is a no-op.
// Runs inside the migration transaction.

import { LEGACY_PREFIX, tableExists } from "../migrate/copy-tables.js";
import { type MigrationDb, defineMigration } from "../migrate/migration.js";

const TABLE = "ext_skill_refs";
const LEGACY = `${LEGACY_PREFIX}${TABLE}`;

const CREATE = `CREATE TABLE ${TABLE} (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (source, path)
  )`;

/** The newest legacy row of each (source, path): no row of the same key is later (created_at, then id). */
const NEWEST = `SELECT id, source, 'skill' AS kind, name, path, sha256, added_by, created_at, created_at AS updated_at FROM ${LEGACY} l
  WHERE NOT EXISTS (SELECT 1 FROM ${LEGACY} n WHERE n.source = l.source AND n.path = l.path AND (n.created_at > l.created_at OR (n.created_at = l.created_at AND n.id > l.id)))`;

const COLUMNS = "id, source, kind, name, path, sha256, added_by, created_at, updated_at";

export default defineMigration({
  change: "breaking",
  tables: [TABLE],
  async up(db) {
    if (await tableExists(db, LEGACY)) return;
    await db.run(`ALTER TABLE ${TABLE} RENAME TO ${LEGACY}`);
    await db.run(CREATE);
    await db.run(`INSERT INTO ${TABLE} (${COLUMNS}) ${NEWEST}`);
  },
  verify: (db: MigrationDb) => verify(db),
});

/** Every (source, path) of the legacy table is one row holding its newest legacy row's values, and nothing else. */
async function verify(db: MigrationDb): Promise<string[]> {
  if (!(await tableExists(db, LEGACY))) return [`${TABLE}: expected ${LEGACY}`];
  const expected = JSON.stringify(await db.all(`SELECT ${COLUMNS} FROM (${NEWEST}) ORDER BY id`));
  const actual = JSON.stringify(await db.all(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY id`));
  return expected === actual ? [] : [`${TABLE}: the rebuilt rows differ from the newest legacy row of each source and path`];
}
