import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { migrateSqlite, sqlitePendingSteps } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import sqlitePlugin from "../src/impl/store/sqlite/sqlite.plugin.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { MIGRATION_PENDING, SUPERVISOR_STATUS_FILE } from "../src/interfaces/updater.js";
import { MIGRATIONS_TABLE, discoverMigrations } from "../src/state/index.js";

// A breaking migration pending after an update (design 08-self-update): the store's open applies it once no factory
// process runs (the drain is done); while one runs it refuses in one line that says the factory is draining or
// migrating; a migration that fails leaves the store as it was and is named.

/** A state dir whose db/factory.db is at the frozen baseline with one row: every timestamped migration is pending. */
async function baselineState(): Promise<{ stateDir: string; file: string }> {
  const stateDir = mkdtempSync(join(tmpdir(), "sf-migrate-on-open-"));
  mkdirSync(join(stateDir, "db"));
  const file = join(stateDir, "db", "factory.db");
  const d = new SqliteDriver(file, { baselineOnly: true });
  await d.migrate();
  await d.run("INSERT INTO cursors (name, value) VALUES ('c1', 'v1')");
  await d.close();
  return { stateDir, file };
}

/** sqlite_master and every row of every table: the whole store. */
async function snapshot(file: string): Promise<unknown> {
  const d = new SqliteDriver(file, { baselineOnly: true });
  try {
    const schema = await d.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const rows: Record<string, unknown> = {};
    for (const t of await d.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) rows[String(t.name)] = await d.all(`SELECT * FROM "${String(t.name)}"`);
    return { schema, rows };
  } finally {
    await d.close();
  }
}

/** The store the sqlite plugin builds for `stateDir`, as `gb task list` gets it. */
const store = (stateDir: string) => sqlitePlugin.create({ loaded: { stateDir }, clock: new FakeClock() } as never) as FactoryStore;

const writeStatus = (stateDir: string, s: Record<string, unknown>) =>
  writeFileSync(join(stateDir, SUPERVISOR_STATUS_FILE), JSON.stringify({ rev: "c1", target_rev: "c2", child_pid: null, draining_pids: [], since: "x", ...s }));

const breakingIds = async () => (await discoverMigrations()).filter((m) => m.change === "breaking").map((m) => m.id);

describe("SQLite open: pending breaking migrations after an update", () => {
  it("apply on open when no factory process runs (no status file, or a stopped one), then nothing is pending", async () => {
    const ids = await breakingIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const status of [null, { state: "stopped", supervisor_pid: process.ppid }]) {
      const { stateDir, file } = await baselineState();
      if (status) writeStatus(stateDir, status);
      const s = store(stateDir);
      await s.migrate();
      await s.close();
      expect(await sqlitePendingSteps(file)).toEqual([]);
      const d = new SqliteDriver(file);
      const applied = (await d.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((r) => String(r.id));
      expect(applied).toEqual(expect.arrayContaining(ids));
      await d.close();
    }
  });

  it("refuse in one line that says the factory is draining or migrating while a supervisor runs, applying nothing", async () => {
    const ids = await breakingIds();
    for (const state of ["migration_draining", "migration_ready", "migration_pending"]) {
      const { stateDir, file } = await baselineState();
      writeStatus(stateDir, { state, supervisor_pid: process.ppid });
      const before = await snapshot(file);
      const s = store(stateDir);
      const err = (await s.migrate().then(() => null, (e: unknown) => e)) as (Error & { code?: string }) | null;
      await s.close();
      expect(err?.code).toBe(MIGRATION_PENDING);
      expect(err!.message).toMatch(/^The factory is draining or migrating: /);
      expect(err!.message).not.toContain("\n");
      for (const id of ids) expect(err!.message).toContain(id);
      expect(err!.message).not.toContain("run `npm run migrate`");
      expect(await snapshot(file)).toEqual(before);
    }
  });

  it("a migration that fails rolls the whole open back and names the failing migration", async () => {
    const { stateDir, file } = await baselineState();
    const first = (await discoverMigrations()).find((m) => m.change !== "contract")!.id;
    // Recording any migration fails: the first one's `up` runs, then its row is refused.
    const d = new SqliteDriver(file, { baselineOnly: true });
    await d.run(`CREATE TABLE ${MIGRATIONS_TABLE} (id TEXT PRIMARY KEY, component TEXT NOT NULL, change_kind TEXT NOT NULL, checksum TEXT NOT NULL, backup_dir TEXT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL)`);
    await d.run(`CREATE TRIGGER refuse_record BEFORE INSERT ON ${MIGRATIONS_TABLE} BEGIN SELECT RAISE(ABORT, 'disk said no'); END`);
    await d.close();
    const before = await snapshot(file);

    const s = store(stateDir);
    await expect(s.migrate()).rejects.toThrow(new RegExp(`^migration ${first} failed; nothing was applied: .*disk said no`));
    await s.close();
    expect(await snapshot(file)).toEqual(before);

    const noSteps = { topicTables: async () => undefined, projectKeys: async () => 0 };
    await expect(migrateSqlite(file, "apply", noSteps, () => undefined)).rejects.toThrow(`migration ${first} failed`);
    expect(await snapshot(file)).toEqual(before);
  });
});
