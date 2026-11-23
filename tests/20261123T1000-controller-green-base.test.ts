import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261123T1001-controller-green-base.migration.js";
import { GreenBaseStore } from "../src/controller/units/local-merge/green-base.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The last green base per project (design 03-risk, red-main revert): `controller_green_bases`. Additive, no backfill,
// rerun-safe; one row per project, the later write wins.

const ID = "20261123T1001-controller-green-base";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const tables = async (db: SqlDriver) => (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));

describe("20261123T1001-controller-green-base on an existing SQLite database", () => {
  it("creates the empty table, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("DROP TABLE controller_green_bases");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    expect(await tables(db)).not.toContain("controller_green_bases");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: ["controller_green_bases"] });
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_green_bases")).toEqual([]);
  });
});

describe("GreenBaseStore", () => {
  it("has no green base until a check passes, keeps one row per project and the later tip", async () => {
    const { store } = await newStore();
    let now = "2026-11-23T10:00:00.000Z";
    const greens = new GreenBaseStore(store.db, () => now);
    expect(await greens.get("o/r")).toBeNull();
    await greens.set("o/r", "a".repeat(40));
    now = "2026-11-23T10:05:00.000Z";
    await greens.set("o/r", "b".repeat(40));
    await greens.set("o/r", "b".repeat(40));
    await greens.set("o/other", "c".repeat(40));
    expect(await greens.get("o/r")).toBe("b".repeat(40));
    expect(await greens.get("o/other")).toBe("c".repeat(40));
    expect(await store.db.all("SELECT project_key, base_sha, checked_at FROM controller_green_bases WHERE project_key = ?", ["o/r"]))
      .toEqual([{ project_key: "o/r", base_sha: "b".repeat(40), checked_at: now }]);
  });
});
