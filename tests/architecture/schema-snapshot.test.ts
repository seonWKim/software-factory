import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MysqlDriver } from "../../src/impl/store/mysql/mysql-driver.js";
import { MysqlMigrations } from "../../src/impl/store/mysql/migrations.js";
import { SqliteDriver } from "../../src/impl/store/sqlite/sqlite-driver.js";
import { ensureTopicTables } from "../../src/bus/index.js";
import { loadRegistry } from "../../src/runtime/registry/registry.js";
import { mysqlSnapshot, sqliteSnapshot } from "../../src/state/snapshot.js";
import type { Dialect, SqlExecutor } from "../../src/state/index.js";
import { MYSQL_URL, newEmptyMysqlDatabase } from "../helpers/store.js";
import { REPO, SRC } from "./lib.js";

// RFC 0015 §6.3: schema/sqlite.sql and schema/mysql.sql are the snapshot of a fresh migration, so every
// schema change shows up in review as a diff of one file. `npm run schema:snapshot` rewrites them
// (MySQL only when SF_TEST_MYSQL_URL is set). A fresh migration includes the sql bus's tables for every
// discovered topic, which the bus creates from the topic descriptors (src/bus/plugins/sql/ddl.ts).

const DIR = join(REPO, "schema");
const UPDATE = process.env.SF_SNAPSHOT_UPDATE === "1";

async function ensureTopics(dialect: Dialect, db: SqlExecutor): Promise<void> {
  const { topics } = await loadRegistry(SRC);
  await ensureTopicTables({ dialect, all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p) }, topics.map((t) => t.descriptor));
}

function compare(file: string, actual: string): void {
  const path = join(DIR, file);
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(existsSync(path), `${path} is missing: run npm run schema:snapshot`).toBe(true);
  expect(actual, `schema/${file} is stale: run npm run schema:snapshot`).toBe(readFileSync(path, "utf8"));
}

describe("schema-snapshot", () => {
  it("schema/sqlite.sql equals a fresh SQLite migration", async () => {
    const driver = new SqliteDriver(":memory:");
    await driver.migrate();
    await ensureTopics("sqlite", driver);
    compare("sqlite.sql", await sqliteSnapshot(driver));
    await driver.close();
  });

  it.skipIf(!MYSQL_URL)("schema/mysql.sql equals a fresh MySQL migration", async () => {
    const db = await newEmptyMysqlDatabase();
    await new MysqlMigrations(await db.connect()).apply(() => undefined);
    const driver = new MysqlDriver(db.options);
    db.onCleanup(() => driver.close());
    await ensureTopics("mysql", driver);
    compare("mysql.sql", await mysqlSnapshot(driver));
  });
});
