import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateCommand } from "../src/impl/store/mysql/migrate-command.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { rehearseSqlite } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { fingerprintTables, lostRows, renameTablesByCopy, type MigrationDb } from "../src/state/index.js";
import { MYSQL_URL, mysqlStepsUpTo, newEmptyMysqlDatabase } from "./helpers/store.js";

// RFC 0015 §12 D8: `npm run migrate -- --rehearse` applies the pending migrations to a copy and checks that
// every row survived; the live database is only read.

const LATEST_STEP = readSteps(STEPS_DIR, INLINE_STEPS).at(-1)!.number;

function sqliteDb(d: SqliteDriver): MigrationDb {
  return { dialect: "sqlite", all: (sql, p) => d.all(sql, p), run: (sql, p) => d.run(sql, p) };
}

describe("rehearsal check", () => {
  it("passes a rename by copy, and names a table that lost or changed rows", async () => {
    const d = new SqliteDriver(":memory:");
    const db = sqliteDb(d);
    await d.run("CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER)");
    await d.run("CREATE TABLE b (id TEXT PRIMARY KEY, n INTEGER)");
    for (let i = 0; i < 50; i++) for (const t of ["a", "b"]) await d.run(`INSERT INTO ${t} VALUES (?, ?)`, [`r${i}`, i]);
    const before = await fingerprintTables(db);
    await renameTablesByCopy(db, [{ from: "a", to: "x_a" }]);
    expect(await lostRows(db, before)).toEqual([]);

    await d.run("DELETE FROM b WHERE id = 'r3'");
    await d.run("UPDATE legacy_a SET n = 0 WHERE id = 'r9'");
    expect(await lostRows(db, before)).toEqual([expect.stringContaining("legacy_a: rows changed"), expect.stringContaining("b: 49 rows")]);
  });

  it("SQLite: rehearses on a copy of the file and leaves the file as it was", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-rehearse-")), "factory.db");
    const d = new SqliteDriver(file, { baselineOnly: true });
    await d.migrate();
    await d.run("INSERT INTO cursors (name, value) VALUES ('c1', 'v1')");
    await d.close();
    const untouched = `${file}.orig`;
    copyFileSync(file, untouched);

    const lines: string[] = [];
    expect(await rehearseSqlite(file, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/^rehearsal passed/);
    const after = new SqliteDriver(file, { baselineOnly: true });
    expect(await after.all("SELECT name FROM sqlite_master WHERE name IN ('cursors', 'inbound_cursors')")).toEqual([{ name: "cursors" }]);
    await after.close();
  });
});

describe.skipIf(!MYSQL_URL)("rehearsal on MySQL", () => {
  it("copies the database, applies the pending migrations there, drops the copy, and leaves the live tables", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(LATEST_STEP) }).apply(() => undefined);
    await c.query("INSERT INTO cursors (name, value) VALUES ('c1', 'v1')");

    const lines: string[] = [];
    expect(await migrateCommand(db.options, "rehearse", (l) => lines.push(l))).toBe(0);
    expect(lines).toContain(`copied ${lines.find((l) => l.startsWith("copied"))!.split(" ")[1]} tables to ${db.database}_rehearsal`);
    expect(lines.at(-1)).toMatch(/^rehearsal passed/);
    const [left] = await c.query("SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name = ?", [`${db.database}_rehearsal`]);
    expect(left).toEqual([]);
    const [live] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('cursors', 'inbound_cursors')");
    expect(live).toEqual([{ t: "cursors" }]);
  });
});
