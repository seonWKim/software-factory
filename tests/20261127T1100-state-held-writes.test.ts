import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261127T1100-state-held-writes.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { TABLE_DOCS } from "../src/state/table-docs.js";
import { newStore } from "./helpers/store.js";

// Held writes (design 08-permissions, phase 2 of local-task-tk_cad55672): one controller_held_writes row per agent
// write the permission gate held, with the mode it ran under. Additive: a new table, no backfill; a pending write key
// is stored once (the partial unique index), and a rerun changes nothing.

const ID = "20261127T1100-state-held-writes";
const TABLE = "controller_held_writes";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const ROW = (id: string, key: string, mode = "ask_all", status = "pending") =>
  `INSERT INTO ${TABLE} (id, write_key, command, args, actor, mode, status, created_at) VALUES ('${id}', '${key}', 'merge', '["wi_1"]', 'service:coordinator', '${mode}', '${status}', '2026-11-27T09:00:00.000Z')`;

describe(ID, () => {
  it("a fresh store has the table, owned by State with a table doc, and the migration recorded as additive", async () => {
    const { store } = await newStore();
    const cols = (await store.db.all(`SELECT name FROM pragma_table_info('${TABLE}')`)).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["id", "write_key", "command", "args", "actor", "mode", "status", "created_at"]));
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: [TABLE] });
    expect(TABLE.startsWith("controller_")).toBe(true);
    expect(TABLE_DOCS[TABLE]).toMatch(/permission mode/);
  });

  it("keeps one pending row per write key, takes another once the first is no longer pending, and refuses an unknown mode", async () => {
    const { store } = await newStore();
    await store.db.run(ROW("hw_1", "coordinator:merge:wi_1"));
    await expect(store.db.run(ROW("hw_2", "coordinator:merge:wi_1"))).rejects.toThrow(/UNIQUE/i);
    await store.db.run(`UPDATE ${TABLE} SET status = 'confirmed' WHERE id = 'hw_1'`);
    await store.db.run(ROW("hw_3", "coordinator:merge:wi_1"));
    await expect(store.db.run(ROW("hw_4", "other", "auto"))).rejects.toThrow(/CHECK/i);
    expect(await store.db.all(`SELECT id, status FROM ${TABLE} ORDER BY id`)).toEqual([{ id: "hw_1", status: "confirmed" }, { id: "hw_3", status: "pending" }]);
  });

  it("creates the table on a store without it, and a rerun keeps every row", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run(`DROP TABLE ${TABLE}`);
    await migration.up(mdb(db));
    await db.run(ROW("hw_1", "k"));
    const before = await db.all(`SELECT * FROM ${TABLE}`);
    await migration.up(mdb(db));
    expect(await db.all(`SELECT * FROM ${TABLE}`)).toEqual(before);
  });
});
