import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261123T1400-controller-skill-eval-run-figures.migration.js";
import type { UserId } from "../src/core/types.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// controller_skill_eval_runs' figures (model class, judge model class, replays, pass rate, errored): additive (five
// nullable columns, no backfill), rerun-safe, and a run stored before them reads null in each.

const ID = "20261123T1400-controller-skill-eval-run-figures";
const FIGURES = ["model_class", "judge_model_class", "replays", "pass_rate", "errored"];
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OWNER = "local:owner" as UserId;

describe(ID, () => {
  it("adds the five nullable columns, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await tableColumns(mdb(db), "controller_skill_eval_runs")).toEqual(expect.arrayContaining(FIGURES));
  });

  it("leaves a run stored before it with null figures: no backfill", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v1" });
    await store.finishSkillEvalRun("r1", "passed");
    await migration.up(mdb(store.db));
    const [run] = await store.listSkillEvalRuns("skills/a");
    expect(run).toMatchObject({ id: "r1", skill_version: "v1", model_class: null, judge_model_class: null, replays: null, pass_rate: null, errored: null });
  });
});
