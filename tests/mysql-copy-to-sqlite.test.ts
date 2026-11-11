import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { type CopyOptions, type SnapshotReader, copyToSqlite, mysqlSnapshotReader } from "../src/impl/store/mysql/copy-to-sqlite.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { type MigrationDb, tableChecksum, tableColumns } from "../src/state/index.js";
import { MYSQL_URL, issue, newMigratedMysqlDatabase, system } from "./helpers/store.js";

const OWNER = "github:1" as UserId;

/** Rows in items, runs, the thread, its outbox, settings and links. */
async function fill(store: FactoryStore): Promise<void> {
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "triage:1" } });
  await store.createWorkItem(issue(2), system);
  await store.recordItemMessage({ work_item_id: item.id, marker: "m1", body: "hello", delivery: { source_type: "github_issue", target: issue(1).source } });
  await store.recordItemMessage({ work_item_id: item.id, marker: "m2", body: "only in the thread" });
  await store.setSettingOverride({ key: "workers", project: "", value: "3", actor: "local:test" });
  await store.createLinkCode(OWNER, "ABCDEFGHJK");
  await store.redeemLinkCode("ABCDEFGHJK", { provider: "github", subject: "12345" });
}

/** What the factory reads back through the store: the same on the source and on the copy. */
async function readBack(store: FactoryStore) {
  const items = await store.listWorkItems(100);
  const per = await Promise.all(
    items.map(async (i) => ({
      item: i,
      runs: await store.listRuns(i.id),
      thread: await store.listItemMessages(i.id),
      outbox: await store.listDeliveries(i.id),
    })),
  );
  return { per, settings: await store.listSettingOverrides(), changes: await store.listSettingChanges(100), links: await store.listLinks(OWNER) };
}

function sqliteDb(d: SqliteDriver): MigrationDb {
  return { dialect: "sqlite", all: (s, p) => d.all(s, p), run: (s, p) => d.run(s, p) };
}

/** A SQLite file filled through the store, read as a copy source (no snapshot needed: nothing writes it). */
async function sqliteSource(extra?: (d: SqliteDriver) => Promise<void>): Promise<{ read: SnapshotReader; driver: SqliteDriver; file: string }> {
  const file = join(mkdtempSync(join(tmpdir(), "sf-copy-src-")), "source.db");
  const store = new SqlFactoryStore(new SqliteDriver(file), new FakeClock());
  await store.migrate();
  await fill(store);
  await store.close();
  const driver = new SqliteDriver(file);
  onTestFinished(() => driver.close());
  if (extra) await extra(driver);
  return { read: (fn) => fn(sqliteDb(driver)), driver, file };
}

function options(over: Partial<CopyOptions> = {}): CopyOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    stateDir: mkdtempSync(join(tmpdir(), "sf-copy-state-")),
    dryRun: false,
    replace: false,
    livePids: async () => [],
    schema: async () => undefined,
    now: () => new Date("2026-11-11T10:00:00.000Z"),
    print: (l) => lines.push(l),
    lines,
    ...over,
  };
}

/** Every file under the state folder, so a refusal can show it wrote none. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

/**
 * Every table of the copy (but SQLite's own schema_migrations) holds the source's rows, compared over all its
 * columns. Returns the tables compared, so a test can check that none was left out.
 */
async function compareAll(source: MigrationDb, target: MigrationDb): Promise<string[]> {
  const tables = (await target.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"))
    .map((r) => String(r.name))
    .filter((t) => t !== "schema_migrations");
  const compared: string[] = [];
  for (const t of tables) {
    const columns = await tableColumns(target, t);
    expect(await tableChecksum(target, t, columns), t).toEqual(await tableChecksum(source, t, columns));
    compared.push(t);
  }
  return compared;
}

async function expectSameStore(sourceStore: FactoryStore, file: string): Promise<void> {
  const copy = new SqlFactoryStore(new SqliteDriver(file), new FakeClock());
  try {
    await copy.migrate();
    const want = await readBack(sourceStore);
    expect(want.per.length).toBe(2);
    expect(want.per.some((p) => p.runs.length > 0 && p.thread.length === 2 && p.outbox.length === 1)).toBe(true);
    expect(want.settings.length).toBeGreaterThan(0);
    expect(want.links.length).toBeGreaterThan(0);
    expect(await readBack(copy)).toEqual(want);
  } finally {
    await copy.close();
  }
}

describe("npm run migrate -- --copy-from-mysql (a SQLite source, no MySQL needed)", () => {
  it("copies every table, checks it and reads back the same data through the store", async () => {
    const src = await sqliteSource();
    const o = options();
    expect(await copyToSqlite(src.read, o)).toBe(0);
    const file = join(o.stateDir, "db", "factory.db");
    expect(files(o.stateDir)).toEqual(["db", "db/factory.db"]);
    expect(o.lines).toContain("skip schema_migrations (schema bookkeeping)");
    expect(o.lines.join("\n")).toContain('"store": { "type": "sqlite" }');
    expect(o.lines.join("\n")).toContain("npm run migrate");
    const target = new SqliteDriver(file);
    try {
      const compared = await compareAll(sqliteDb(src.driver), sqliteDb(target));
      for (const t of ["controller_work_items", "controller_item_thread", "worker_runs", "runtime_settings_overrides", "identity_user_links", "outbound_intents"]) expect(compared).toContain(t);
      // Insertion order (the store's tie-break, rowid on SQLite) survives the copy in primary-key order.
      const order = "SELECT rowid AS r, id FROM controller_work_items ORDER BY rowid";
      expect(await target.all(order)).toEqual(await src.driver.all(order));
    } finally {
      await target.close();
    }
    const sourceStore = new SqlFactoryStore(new SqliteDriver(src.file), new FakeClock());
    try {
      await expectSameStore(sourceStore, file);
    } finally {
      await sourceStore.close();
    }
  });

  it("refuses while a factory process is live, names the pids, and writes nothing", async () => {
    const src = await sqliteSource();
    const o = options({ livePids: async () => [4242, 4343] });
    expect(await copyToSqlite(src.read, o)).toBe(1);
    expect(o.lines.join("\n")).toMatch(/refusing: .*4242, 4343/);
    expect(files(o.stateDir)).toEqual([]);
  });

  it("refuses a table the SQLite schema lacks, legacy_* included, lists them, and writes nothing", async () => {
    const src = await sqliteSource(async (d) => {
      await d.run("CREATE TABLE extra_things (id INTEGER PRIMARY KEY)");
      await d.run("CREATE TABLE legacy_gone (id INTEGER PRIMARY KEY)");
    });
    const o = options();
    expect(await copyToSqlite(src.read, o)).toBe(1);
    expect(o.lines.join("\n")).toMatch(/refusing: .*extra_things/);
    expect(o.lines.join("\n")).toMatch(/refusing: .*legacy_gone/);
    expect(files(o.stateDir)).toEqual([]);
  });

  it("a second run without --replace refuses and changes nothing; with --replace the old file goes to db/backups first", async () => {
    const src = await sqliteSource();
    const first = options();
    expect(await copyToSqlite(src.read, first)).toBe(0);
    const file = join(first.stateDir, "db", "factory.db");
    const before = readFileSync(file);
    const listed = files(first.stateDir);

    const again = options({ stateDir: first.stateDir });
    expect(await copyToSqlite(src.read, again)).toBe(1);
    expect(again.lines.join("\n")).toMatch(/refusing: .*already holds data.*--replace/);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(files(first.stateDir)).toEqual(listed);

    const replace = options({ stateDir: first.stateDir, replace: true });
    expect(await copyToSqlite(src.read, replace)).toBe(0);
    const backup = join(first.stateDir, "db", "backups", "factory-2026-11-11T10-00-00-000Z.db");
    expect(readFileSync(backup).equals(before)).toBe(true);
    const moved = replace.lines.findIndex((l) => l.includes(backup));
    const copied = replace.lines.findIndex((l) => l.startsWith("copied "));
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThan(copied);
    expect(existsSync(file)).toBe(true);
  });

  it("a file the factory only built, with no data, needs no --replace", async () => {
    const src = await sqliteSource();
    const o = options();
    mkdirSync(join(o.stateDir, "db"));
    const built = new SqliteDriver(join(o.stateDir, "db", "factory.db"));
    await built.migrate();
    await built.close();
    expect(await copyToSqlite(src.read, o)).toBe(0);
    expect(o.lines.some((l) => l.includes(join("db", "backups")))).toBe(true);
  });

  it("--dry-run lists each table with its row count, writes no file and needs no stopped factory", async () => {
    const src = await sqliteSource();
    const o = options({ dryRun: true, livePids: async () => [4242] });
    expect(await copyToSqlite(src.read, o)).toBe(0);
    expect(o.lines).toContain("controller_work_items: 2 rows");
    expect(o.lines).toContain("dry run: nothing was written");
    expect(files(o.stateDir)).toEqual([]);
  });

  it("a count mismatch deletes the new file and its sidecars, names the table, and leaves no SQLite file", async () => {
    const src = await sqliteSource();
    // A source that is not one snapshot: a row lands in controller_work_items after the copy read it, before the check.
    let added = false;
    const read: SnapshotReader = (fn) =>
      fn({
        dialect: "sqlite",
        all: async (sql, params) => {
          const rows = await src.driver.all(sql, params);
          if (!added && /FROM `controller_work_items` ORDER BY/.test(sql)) {
            added = true;
            const [row] = await src.driver.all("SELECT * FROM controller_work_items LIMIT 1");
            const cols = Object.keys(row!);
            const values = cols.map((c) => (c === "id" ? "wi_extra" : c === "source_id" ? "o/r#99" : row![c]!));
            await src.driver.run(`INSERT INTO controller_work_items (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values as (string | number | null)[]);
          }
          return rows;
        },
        run: (s, p) => src.driver.run(s, p),
      });
    const o = options();
    expect(await copyToSqlite(read, o)).toBe(1);
    expect(added).toBe(true);
    expect(o.lines.join("\n")).toMatch(/mismatch: controller_work_items: SQLite has 2 rows, MySQL has 3/);
    expect(files(o.stateDir)).toEqual(["db"]);
  });
});

describe.skipIf(!MYSQL_URL)("npm run migrate -- --copy-from-mysql (MySQL)", () => {
  it("copies items, threads, runs, settings, links and outbox; every SQLite table matches MySQL; the store reads the same data", async () => {
    const db = await newMigratedMysqlDatabase();
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await fill(store);
    const read = mysqlSnapshotReader(db.options);
    const o = options();
    expect(await copyToSqlite(read, o)).toBe(0);
    const file = join(o.stateDir, "db", "factory.db");
    const target = new SqliteDriver(file);
    try {
      const sqliteTables = (await target.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")).map((r) => String(r.name));
      const compared = await read((mysqlDb) => compareAll(mysqlDb, sqliteDb(target)));
      expect(compared.sort()).toEqual(sqliteTables.filter((t) => t !== "schema_migrations").sort());
    } finally {
      await target.close();
    }
    await expectSameStore(store, file);
  });
});
