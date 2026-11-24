import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1001-controller-tasks-link-note.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// A moved task's note (design 02-tasks-build): the nullable `link_note` on controller_tasks. Additive, no backfill (a
// task closed by hand, or any other existing task, keeps its state), rerun-safe.

const ID = "20261124T1001-controller-tasks-link-note";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe("20261124T1001-controller-tasks-link-note on an existing SQLite database", () => {
  it("a fresh store has the column and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "controller_tasks")).toContain("link_note");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("adds the nullable link_note, backfills nothing, keeps every task's state and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_tasks DROP COLUMN link_note");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    // A task closed by hand while its rejected item was refiled, and an open linked one.
    await db.run("INSERT INTO controller_tasks (id, title, created_by, created_at, done_at, work_item_id) VALUES ('tk_hand', 'by hand', 'local:owner', '2026-11-20T00:00:00.000Z', '2026-11-24T01:00:00.000Z', 'wi_old')");
    await db.run("INSERT INTO controller_tasks (id, title, created_by, created_at, done_at, work_item_id) VALUES ('tk_open', 'open', 'local:owner', '2026-11-20T00:00:00.000Z', NULL, 'wi_dead')");
    expect(await tableColumns(mdb(db), "controller_tasks")).not.toContain("link_note");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    const rows = "SELECT id, done_at, work_item_id, link_note FROM controller_tasks ORDER BY id";
    const after = [
      { id: "tk_hand", done_at: "2026-11-24T01:00:00.000Z", work_item_id: "wi_old", link_note: null },
      { id: "tk_open", done_at: null, work_item_id: "wi_dead", link_note: null },
    ];
    expect(await db.all(rows)).toEqual(after);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    expect(await db.all(rows)).toEqual(after);
  });
});
