import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261125T1200-controller-skill-eval-gate.migration.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The new-version gate table (design 07-self-improvement): additive, rerun-safe, and no gate row is backfilled for a
// version recorded before it.

const ID = "20261125T1200-controller-skill-eval-gate";
const COLUMNS = ["ref_id", "version", "state", "lease_token", "lease_until", "run_id", "detail", "created_at", "updated_at"];
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(ID, () => {
  it("creates controller_skill_version_gates, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await tableColumns(mdb(db), "controller_skill_version_gates")).toEqual(expect.arrayContaining(COLUMNS));
  });

  it("backfills no gate row for a version stored before it", async () => {
    const { store } = await newStore();
    await store.db.run("INSERT INTO ext_skill_versions (ref_id, version, folder_hash, text, source, created_at) VALUES ('sr_a', 1, 'h1', 'A', 'claude', 't')");
    await migration.up(mdb(store.db));
    expect(await store.getSkillVersionGate("sr_a", 1)).toBeNull();
  });
});
