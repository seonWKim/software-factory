// `npm run migrate` on SQLite. --status and --dry-run only read: they list the pending baseline steps and
// timestamped migrations and never open the store for writing. Apply mode (after the command's drain) brings
// the schema to the latest, breaking migrations included, then runs the project-key data step.

import { existsSync } from "node:fs";
import { type Migration, pendingMigrations } from "../../../state/index.js";
import { type ProjectKeyMode, countLegacyProjectRows } from "../project-keys.js";
import { SqliteDriver } from "./sqlite-driver.js";

/** What the schema still needs: baseline steps not recorded, and timestamped migrations not applied. Read-only. */
async function pendingSchema(driver: SqliteDriver): Promise<{ baseline: number; migrations: Migration[] }> {
  const v = await driver.schemaVersion();
  return { baseline: v.latest - v.applied, migrations: await pendingMigrations({ dialect: "sqlite", all: (s, p) => driver.all(s, p), run: (s, p) => driver.run(s, p) }) };
}

/**
 * The steps the supervisor must wait on before it starts a new revision against `file` (`migrate --status
 * --json`): pending breaking migrations (they rename tables the running child writes, RFC 0015 §12 D1), then
 * the project-key data step. Additive migrations are left out: the new child applies them safely on open.
 */
export async function sqlitePendingSteps(file: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  const driver = new SqliteDriver(file);
  try {
    const breaking = (await pendingSchema(driver)).migrations.filter((m) => m.change === "breaking");
    if (breaking.length > 0) return breaking.map((m) => `${m.id} (breaking)`);
    const n = await countLegacyProjectRows(driver).catch(() => 0);
    return n > 0 ? [`project keys (${n} row${n === 1 ? "" : "s"})`] : [];
  } finally {
    await driver.close();
  }
}

export interface SqliteMigrateSteps {
  /** After the schema is current, apply mode only: the discovered topic tables. */
  topicTables(driver: SqliteDriver): Promise<void>;
  /** The project-key data step, in the given mode. */
  projectKeys(driver: SqliteDriver, mode: ProjectKeyMode): Promise<number>;
}

/** `npm run migrate [--status | --dry-run]` on SQLite; --status and --dry-run change nothing. */
export async function migrateSqlite(file: string, mode: ProjectKeyMode, steps: SqliteMigrateSteps, print: (line: string) => void): Promise<number> {
  if (mode === "apply") {
    const driver = new SqliteDriver(file, { applyBreaking: true });
    try {
      await driver.migrate();
      await steps.topicTables(driver);
      return await steps.projectKeys(driver, mode);
    } finally {
      await driver.close();
    }
  }
  if (!existsSync(file)) {
    print(`schema: ${file} does not exist yet; the factory creates it at the latest schema when it first opens it`);
    return 0;
  }
  const driver = new SqliteDriver(file);
  try {
    const { baseline, migrations } = await pendingSchema(driver);
    if (baseline === 0 && migrations.length === 0) {
      print("schema: pending: none (up to date)");
      return await steps.projectKeys(driver, mode);
    }
    if (baseline > 0) print(`schema: ${baseline} baseline step${baseline === 1 ? "" : "s"} pending`);
    for (const m of migrations) print(`schema: pending ${m.id} (${m.change}${m.change === "breaking" ? `: backs up ${m.tables.join(", ")} first` : ""})`);
    print("project keys: listed once the pending schema steps have run (npm run migrate, then --dry-run again)");
    if (mode === "dry-run") print("dry run: nothing was changed");
    return 0;
  } finally {
    await driver.close();
  }
}
