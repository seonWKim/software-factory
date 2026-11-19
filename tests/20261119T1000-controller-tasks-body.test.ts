import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261119T1000-controller-tasks-body.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// A plain task's description (design 02-tasks): the nullable `body` on controller_tasks. Additive, no backfill, rerun-safe.

const ID = "20261119T1000-controller-tasks-body";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe("20261119T1000-controller-tasks-body on an existing SQLite database", () => {
  it("a fresh store has the column and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "controller_tasks")).toContain("body");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("adds the nullable body, backfills nothing, keeps the rows and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_tasks DROP COLUMN body");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run("INSERT INTO controller_tasks (id, title, created_by, created_at) VALUES ('tk_old', 'old', 'u', '2026-01-01T00:00:00.000Z')");
    expect(await tableColumns(mdb(db), "controller_tasks")).not.toContain("body");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await db.all("SELECT id, title, body FROM controller_tasks")).toEqual([{ id: "tk_old", title: "old", body: null }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all("SELECT id, title, body FROM controller_tasks")).toEqual([{ id: "tk_old", title: "old", body: null }]);
    expect(await store.getTask("tk_old")).toMatchObject({ body: null });
    expect(await store.setTaskBody("tk_old", "notes")).toMatchObject({ ok: true, task: { body: "notes" } });
  });
});
