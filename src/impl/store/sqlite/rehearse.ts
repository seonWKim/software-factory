// `npm run migrate -- --rehearse` on SQLite (RFC 0015 §12 D8): the database file is copied with VACUUM INTO,
// the copy is brought to the frozen baseline and fingerprinted, then the pending migrations run on it and no
// row may be lost or changed. The live file is only read; the copy is deleted.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintTables, lostRows, type MigrationDb, type SqlExecutor } from "../../../state/index.js";
import { SqliteDriver } from "./sqlite-driver.js";

function migrationDb(d: SqlExecutor): MigrationDb {
  return { dialect: "sqlite", all: (sql, params) => d.all(sql, params), run: (sql, params) => d.run(sql, params) };
}

export async function rehearseSqlite(file: string, print: (line: string) => void): Promise<number> {
  if (!existsSync(file)) {
    print(`nothing to rehearse: ${file} does not exist yet`);
    return 0;
  }
  const dir = await mkdtemp(join(tmpdir(), "sf-rehearsal-"));
  const copy = join(dir, "factory.db");
  try {
    const live = new SqliteDriver(file);
    try {
      await live.run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } finally {
      await live.close();
    }
    print(`copied ${file} to ${copy}`);
    const baseline = new SqliteDriver(copy, { baselineOnly: true });
    let before;
    try {
      await baseline.migrate();
      before = await fingerprintTables(migrationDb(baseline));
    } finally {
      await baseline.close();
    }
    const after = new SqliteDriver(copy);
    try {
      await after.migrate();
      const lost = await lostRows(migrationDb(after), before);
      for (const line of lost) print(`lost: ${line}`);
      print(lost.length === 0 ? `rehearsal passed: every row of ${before.size} tables is still there` : "rehearsal FAILED: do not open the live database with this version");
      return lost.length === 0 ? 0 : 1;
    } finally {
      await after.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
