import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../../src/impl/store/sqlite/sqlite-driver.js";
import { ensureDiscoveredTopicTables } from "../../src/runtime/index.js";
import { sqliteSnapshot } from "../../src/state/snapshot.js";
import type { Dialect, SqlExecutor } from "../../src/state/index.js";
import { REPO, SRC } from "./lib.js";

// RFC 0015 §6.3: schema/sqlite.sql is the snapshot of a fresh migration, so every
// schema change shows up in review as a diff of one file. `npm run schema:snapshot` rewrites it. A fresh migration includes the sql bus's tables for every
// discovered topic, which the bus creates from the topic descriptors (src/bus/plugins/sql/ddl.ts).

const DIR = join(REPO, "schema");
const UPDATE = process.env.SF_SNAPSHOT_UPDATE === "1";

function ensureTopics(dialect: Dialect, db: SqlExecutor): Promise<void> {
  return ensureDiscoveredTopicTables(dialect, db, SRC);
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
});
