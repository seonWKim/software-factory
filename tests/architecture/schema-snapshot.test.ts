import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../../src/impl/store/sqlite/sqlite-driver.js";
import { ensureDiscoveredTopicTables } from "../../src/runtime/index.js";
import { sqliteSnapshot } from "../../src/state/snapshot.js";
import type { Dialect, SqlExecutor } from "../../src/state/index.js";
import { REPO, SRC, TABLE_PREFIXES } from "./lib.js";

// RFC 0015 §6.3: schema/sqlite/ is the snapshot of a fresh migration, one file per owner prefix, so every
// schema change shows up in review as a diff of its owner's file. `npm run schema:snapshot` rewrites the files
// and removes any it no longer produces. A fresh migration includes the sql bus's tables for every
// discovered topic, which the bus creates from the topic descriptors (src/bus/plugins/sql/ddl.ts).

const DIR = join(REPO, "schema", "sqlite");
const UPDATE = process.env.SF_SNAPSHOT_UPDATE === "1";

function ensureTopics(dialect: Dialect, db: SqlExecutor): Promise<void> {
  return ensureDiscoveredTopicTables(dialect, db, SRC);
}

function onDisk(): string[] {
  return existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort() : [];
}

function compare(files: ReadonlyMap<string, string>): void {
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    for (const stale of onDisk().filter((f) => !files.has(f))) rmSync(join(DIR, stale));
    for (const [file, text] of files) writeFileSync(join(DIR, file), text);
    return;
  }
  expect(onDisk(), "schema/sqlite/ has missing or extra files: run npm run schema:snapshot").toEqual([...files.keys()].sort());
  for (const [file, text] of files) {
    expect(text, `schema/sqlite/${file} is stale: run npm run schema:snapshot`).toBe(readFileSync(join(DIR, file), "utf8"));
  }
}

describe("schema-snapshot", () => {
  it("schema/sqlite/ equals a fresh SQLite migration, one file per owner prefix", async () => {
    const driver = new SqliteDriver(":memory:");
    await driver.migrate();
    await ensureTopics("sqlite", driver);
    compare(await sqliteSnapshot(driver, Object.keys(TABLE_PREFIXES)));
    await driver.close();
  });
});
