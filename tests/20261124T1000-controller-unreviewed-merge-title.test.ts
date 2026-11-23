import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1000-controller-unreviewed-merge-title.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// A merged PR's title on its unreviewed merge row (design 09-dashboard-tasks-needs): the nullable `title` on
// controller_unreviewed_merges. Additive, no backfill, rerun-safe.

const ID = "20261124T1000-controller-unreviewed-merge-title";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const KEY = "github:github.com:R_1";

describe("20261124T1000-controller-unreviewed-merge-title on an existing SQLite database", () => {
  it("a fresh store has the column and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "controller_unreviewed_merges")).toContain("title");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("adds the nullable title, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_unreviewed_merges DROP COLUMN title");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run("INSERT INTO controller_unreviewed_merges (id, project, change_ref, merge_sha, merger_id, at) VALUES ('um_old', ?, '436', 'm436', NULL, '2026-11-08T00:45:03.671Z')", [KEY]);
    expect(await tableColumns(mdb(db), "controller_unreviewed_merges")).not.toContain("title");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await db.all("SELECT id, change_ref, title FROM controller_unreviewed_merges")).toEqual([{ id: "um_old", change_ref: "436", title: null }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await store.listUnreviewedMerges(10)).toMatchObject([{ change_ref: "436", title: null }]);
    const { merge } = await store.recordUnreviewedMerge({ project: KEY, change_ref: "437", merge_sha: "m437", merger_id: null, title: "Seed golden cases" });
    expect(merge.title).toBe("Seed golden cases");
  });
});
