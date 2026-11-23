import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261119T1200-controller-project-folder.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// A task project's base folder (design 02-tasks, project files): the nullable `base_folder` on controller_projects.
// Additive, no backfill, rerun-safe.

const ID = "20261119T1200-controller-project-folder";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe("20261119T1200-controller-project-folder on an existing SQLite database", () => {
  it("a fresh store has the column and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "controller_projects")).toContain("base_folder");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("adds the nullable base_folder, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_projects DROP COLUMN base_folder");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run("INSERT INTO controller_projects (id, slug, name, created_by, created_at) VALUES ('pj_old', 'old', 'Old', 'u', '2026-01-01T00:00:00.000Z')");
    expect(await tableColumns(mdb(db), "controller_projects")).not.toContain("base_folder");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await db.all("SELECT id, name, base_folder FROM controller_projects")).toEqual([{ id: "pj_old", name: "Old", base_folder: null }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT id, name, base_folder FROM controller_projects")).toEqual([{ id: "pj_old", name: "Old", base_folder: null }]);
    expect(await store.getProject("pj_old")).toMatchObject({ base_folder: null });
    expect(await store.setProjectFolder("pj_old", "/tmp/x")).toMatchObject({ ok: true, project: { base_folder: "/tmp/x" } });
  });
});
