// Rule D8 (RFC 0015 §12): rehearse on a copy. Before the pending migrations run on a copy of the database,
// every table is fingerprinted. Afterwards each one must still hold the same rows over its old columns,
// either under its own name or as its legacy_ archive. A migration only adds or copies data (D2), so any
// other difference means data would be lost or changed.

import { tableChecksum, type TableSummary } from "./backup.js";
import { LEGACY_PREFIX, tableColumns, tableExists } from "./copy-tables.js";
import type { MigrationDb } from "./migration.js";
import { MIGRATIONS_TABLE } from "./runner.js";

/** Bookkeeping tables whose rows a migration run is meant to change. */
const BOOKKEEPING = new Set(["schema_state", "schema_migrations", MIGRATIONS_TABLE]);

export interface Fingerprint extends TableSummary {
  readonly columns: readonly string[];
}

async function tables(db: MigrationDb): Promise<string[]> {
  const rows = await db.all("SELECT name AS t FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  return rows.map((r) => String(r.t)).filter((t) => !BOOKKEEPING.has(t));
}

/** Row count and checksum of every table, over its current columns. */
export async function fingerprintTables(db: MigrationDb): Promise<Map<string, Fingerprint>> {
  const out = new Map<string, Fingerprint>();
  for (const t of await tables(db)) {
    const columns = await tableColumns(db, t);
    out.set(t, { ...(await tableChecksum(db, t, columns)), columns });
  }
  return out;
}

/** Tables whose rows did not survive: each is compared with its legacy_ archive when one exists. */
export async function lostRows(db: MigrationDb, before: ReadonlyMap<string, Fingerprint>): Promise<string[]> {
  const out: string[] = [];
  for (const [t, was] of before) {
    const now = (await tableExists(db, LEGACY_PREFIX + t)) ? LEGACY_PREFIX + t : (await tableExists(db, t)) ? t : null;
    if (now === null) {
      if (was.rows > 0) out.push(`${t}: ${was.rows} rows gone (no table and no ${LEGACY_PREFIX}${t})`);
      continue;
    }
    const is = await tableChecksum(db, now, was.columns);
    if (is.rows !== was.rows) out.push(`${now}: ${is.rows} rows, ${t} had ${was.rows}`);
    else if (is.checksum !== was.checksum) out.push(`${now}: rows changed over ${t}'s columns`);
  }
  return out;
}
