import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261120T1001-controller-routines.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { issue, newStore, system } from "./helpers/store.js";

// Routines (src/core/routines.ts): `controller_routines` and `controller_routine_suggestions`. Additive, no backfill
// and no row created (a store opened before has no routine and no suggestion), rerun-safe, and its timestamp is
// unique among every component's migrations.

const ID = "20261120T1001-controller-routines";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const columns = async (db: SqlDriver, table: string) => (await db.all(`PRAGMA table_info(${table})`)).map((r) => r.name);

describe(`${ID} on an existing SQLite database`, () => {
  it("creates both tables empty, keeps every row, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    await store.createWorkItem(issue(1), system);
    const db = store.db;
    await db.run("DROP TABLE controller_routine_suggestions");
    await db.run("DROP TABLE controller_routines");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    const before = await db.all("SELECT * FROM controller_work_items");
    const changes = await db.all("SELECT * FROM controller_state_changes");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: ["controller_routines", "controller_routine_suggestions"] });
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_work_items")).toEqual(before);
    expect(await db.all("SELECT * FROM controller_state_changes")).toEqual(changes);
    expect(await store.listRoutines()).toEqual([]);
    expect(await db.all("SELECT * FROM controller_routine_suggestions")).toEqual([]);
    expect(await columns(db, "controller_routines")).toEqual([
      "id", "name", "instruction", "url", "cadence_kind", "cadence_spec", "zone", "trigger_kind", "run_cap_usd", "daily_cap_usd",
      "cap_raise_usd", "cap_raise_day", "cap_hold_key", "paused", "created_by", "created_at", "next_due_at", "last_run_at",
    ]);
    expect(await columns(db, "controller_routine_suggestions")).toEqual([
      "id", "routine_id", "run_id", "fingerprint", "text", "state", "duplicates", "last_run_id", "snoozed_until", "filed_ref", "decided_by", "decided_at", "created_at",
    ]);
    expect((await db.all("PRAGMA index_list(controller_routines)")).map((r) => r.name)).toContain("controller_routines_due");
  });

  it("has a timestamp no other migration uses", () => {
    const src = join(import.meta.dirname, "..", "src");
    const stamps = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".migration.ts"))
      .map((f) => f.split("/").pop()!.slice(0, 13));
    expect(stamps.filter((s) => s === "20261120T1001")).toEqual(["20261120T1001"]);
  });
});
