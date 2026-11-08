import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { backupTables, restoreBackup, tableChecksum, verifyCopy } from "../src/state/index.js";

// RFC 0015 §12: back up, verify a copy, restore. No data may be lost or changed on the way.

async function db() {
  const d = new SqliteDriver(":memory:");
  await d.run("CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER, body TEXT)");
  for (let i = 0; i < 2_500; i++) await d.run("INSERT INTO a VALUES (?, ?, ?)", [`id${i}`, i, i % 7 ? `text ${i} ✓` : null]);
  return d;
}

describe("migration safety kit", () => {
  it("checksums ignore row order and see any changed value", async () => {
    const d = await db();
    await d.run("CREATE TABLE b (id TEXT PRIMARY KEY, n INTEGER, body TEXT)");
    await d.run("INSERT INTO b SELECT * FROM a ORDER BY n DESC");
    expect(await verifyCopy(d, "a", "b", ["id", "n", "body"])).toEqual([]);
    await d.run("UPDATE b SET body = 'changed' WHERE id = 'id1234'");
    expect(await verifyCopy(d, "a", "b", ["id", "n", "body"])).toEqual([expect.stringContaining("differs")]);
    await d.run("DELETE FROM b WHERE id = 'id1'");
    expect(await verifyCopy(d, "a", "b", ["id", "n", "body"])).toEqual([expect.stringContaining("2499 rows")]);
  });

  it("verifies a copy whose columns were renamed", async () => {
    const d = await db();
    await d.run("CREATE TABLE c (key TEXT PRIMARY KEY, num INTEGER, text TEXT, extra TEXT)");
    await d.run("INSERT INTO c (key, num, text, extra) SELECT id, n, body, 'new' FROM a");
    expect(await verifyCopy(d, "a", "c", { id: "key", n: "num", body: "text" })).toEqual([]);
  });

  it("backs up every row and restores them exactly, inside one transaction", async () => {
    const d = await db();
    const before = await tableChecksum(d, "a");
    const dir = join(mkdtempSync(join(tmpdir(), "sf-backup-")), "b1");
    const manifest = await backupTables(d, ["a"], dir, { id: "b1", reason: "test", created_at: "2026-11-08T00:00:00.000Z" });
    expect(manifest.tables.a).toEqual(before);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2_500);

    await d.run("DELETE FROM a WHERE n > 100");
    await d.run("UPDATE a SET body = 'lost' WHERE n = 5");
    await d.transaction((tx) => restoreBackup(tx, dir));
    expect(await tableChecksum(d, "a")).toEqual(before);
  });
});
