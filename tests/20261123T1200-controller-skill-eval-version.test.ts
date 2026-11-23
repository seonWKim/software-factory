import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261123T1200-controller-skill-eval-version.migration.js";
import type { UserId } from "../src/core/types.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// controller_skill_eval_runs.skill_version: additive (one nullable column, no backfill), rerun-safe, and the store
// writes and reads it.

const ID = "20261123T1200-controller-skill-eval-version";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OWNER = "local:owner" as UserId;

describe(ID, () => {
  it("adds the nullable column, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "k", title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v1" });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await tableColumns(mdb(db), "controller_skill_eval_runs")).toContain("skill_version");
    expect(await db.all("SELECT skill_version FROM controller_skill_eval_runs WHERE id = 'r1'")).toEqual([{ skill_version: "v1" }]);
  });

  it("stores the run's skill version, null when none is given, and keeps the first on a second start", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "k", title: "t", created_by: OWNER });
    expect(await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "abc" })).toMatchObject({ skill_version: "abc" });
    expect(await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "other" })).toMatchObject({ skill_version: "abc" });
    expect(await store.startSkillEvalRun({ id: "r2", suite_id: "s1", created_by: OWNER })).toMatchObject({ skill_version: null });
  });
});
