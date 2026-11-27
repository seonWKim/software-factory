import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261128T0900-state-held-write-origin.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import type { UserId } from "../src/core/types.js";
import { newStore } from "./helpers/store.js";

// The held write's origin (design 08-permissions, phase 4): controller_held_writes gains a nullable `write_origin`,
// `agent` on every new held write. Additive: a row held before reads NULL (no backfill), and a rerun changes nothing.

const ID = "20261128T0900-state-held-write-origin";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OLD = "INSERT INTO controller_held_writes (id, write_key, command, args, actor, mode, status, created_at) VALUES ('hw_old', 'k_old', 'merge', '[]', 'service:coordinator', 'ask_all', 'pending', '2026-11-27T00:00:00.000Z')";

describe(ID, () => {
  it("a fresh store has the column and the migration recorded; a new held write records origin agent", async () => {
    const { store } = await newStore();
    const cols = (await store.db.all("SELECT name FROM pragma_table_info('controller_held_writes')")).map((r) => r.name);
    expect(cols).toContain("write_origin");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: ["controller_held_writes"] });
    const { write } = await store.holdWrite({ key: "k1", command: "merge", args: ["wi_1"], actor: "service:coordinator" as UserId, mode: "ask_all" });
    expect(write).toMatchObject({ write_origin: "agent", mode: "ask_all" });
    expect(await store.db.all("SELECT write_origin FROM controller_held_writes WHERE id = ?", [write.id])).toEqual([{ write_origin: "agent" }]);
  });

  it("adds the column, keeps a row held before with NULL, refuses any other origin, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_held_writes DROP COLUMN write_origin");
    await db.run(OLD);
    const before = await db.all("SELECT * FROM controller_held_writes");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_held_writes")).toEqual(before.map((r) => ({ ...r, write_origin: null })));
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_held_writes")).toEqual(before.map((r) => ({ ...r, write_origin: null })));
    expect((await store.getHeldWrite("hw_old"))!.write_origin).toBeNull();
    await expect(db.run("UPDATE controller_held_writes SET write_origin = 'human_command' WHERE id = 'hw_old'")).rejects.toThrow(/CHECK/i);
  });
});
