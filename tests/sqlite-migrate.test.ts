import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_PENDING } from "../src/interfaces/updater.js";
import { migrateSqlite, sqlitePendingSteps } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { discoverMigrations, MIGRATIONS_TABLE } from "../src/state/index.js";

// SQLite and breaking migrations (RFC 0015 §12 D1, design 08-self-update): only `npm run migrate` applies one to
// a database that holds data, after its drain. --status, --dry-run, the supervisor's check and every other open
// leave the schema as it was.

/** A file database at the frozen baseline with one row: every timestamped migration is pending. */
async function baselineDb(): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "sf-sqlite-migrate-")), "factory.db");
  const d = new SqliteDriver(file, { baselineOnly: true });
  await d.migrate();
  await d.run("INSERT INTO cursors (name, value) VALUES ('c1', 'v1')");
  await d.close();
  return file;
}

async function schema(file: string): Promise<unknown[]> {
  const d = new SqliteDriver(file, { baselineOnly: true });
  try {
    return await d.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  } finally {
    await d.close();
  }
}

const breakingIds = async () => (await discoverMigrations()).filter((m) => m.change === "breaking").map((m) => m.id);
const noSteps = { topicTables: async () => undefined, projectKeys: async () => 0 };

describe("SQLite: a pending breaking migration", () => {
  it("is reported to the supervisor's check, which changes nothing", async () => {
    const ids = await breakingIds();
    expect(ids.length).toBeGreaterThan(0);
    const file = await baselineDb();
    const before = await schema(file);
    expect(await sqlitePendingSteps(file)).toEqual(ids.map((id) => `${id} (breaking)`));
    expect(await schema(file)).toEqual(before);
  });

  it("makes every other open refuse with MIGRATION_PENDING, applying nothing; a new database still opens", async () => {
    const file = await baselineDb();
    const before = await schema(file);
    const d = new SqliteDriver(file);
    await expect(d.migrate()).rejects.toMatchObject({ code: MIGRATION_PENDING, message: expect.stringContaining("npm run migrate") });
    await d.close();
    expect(await schema(file)).toEqual(before);

    const fresh = new SqliteDriver(join(mkdtempSync(join(tmpdir(), "sf-sqlite-fresh-")), "factory.db"));
    await fresh.migrate();
    expect(await fresh.all(`SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`)).not.toEqual([{ n: 0 }]);
    await fresh.close();
  });

  it("--status and --dry-run list it and leave the schema unchanged; apply migrates", async () => {
    const ids = await breakingIds();
    const file = await baselineDb();
    const before = await schema(file);
    for (const mode of ["status", "dry-run"] as const) {
      const lines: string[] = [];
      expect(await migrateSqlite(file, mode, noSteps, (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual(expect.arrayContaining(ids.map((id) => expect.stringContaining(`schema: pending ${id} (breaking`))));
      expect(await schema(file)).toEqual(before);
    }

    expect(await migrateSqlite(file, "apply", noSteps, () => undefined)).toBe(0);
    expect(await schema(file)).not.toEqual(before);
    expect(await sqlitePendingSteps(file)).toEqual([]);
  });
});
