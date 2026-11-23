import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261121T1002-controller-skill-evals.migration.js";
import type { UserId } from "../src/core/types.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// Skill-eval tables: additive, rerun-safe, and the store methods round-trip a suite, a case, a run and a replay.

const ID = "20261121T1002-controller-skill-evals";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OWNER = "local:owner" as UserId;
const COLUMNS: Record<string, string[]> = {
  controller_skill_eval_suites: ["id", "skill_ref", "title", "created_by", "created_at"],
  controller_skill_eval_cases: ["id", "suite_id", "input", "expected", "created_at"],
  controller_skill_eval_runs: ["id", "suite_id", "status", "started_at", "finished_at", "created_by"],
  controller_skill_eval_replays: ["run_id", "case_id", "verdict", "detail", "recorded_at"],
};

describe("20261121T1002-controller-skill-evals", () => {
  it("creates each table with its columns and is safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "k", title: "t", created_by: OWNER });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    for (const [table, cols] of Object.entries(COLUMNS)) expect(await tableColumns(mdb(db), table)).toEqual(expect.arrayContaining(cols));
    expect(await store.listSkillEvalSuites()).toHaveLength(1);
  });

  it("round-trips a suite, a case, a run and a replay", async () => {
    const { store } = await newStore();
    const suite = await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/triage", title: "Triage", created_by: OWNER });
    expect(await store.createSkillEvalSuite({ id: "s1", skill_ref: "other", title: "x", created_by: OWNER })).toEqual(suite);
    expect(await store.listSkillEvalSuites()).toEqual([suite]);

    const c = await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: { q: 1 }, expected: ["a"] });
    expect(c).toMatchObject({ input: { q: 1 }, expected: ["a"] });
    expect(await store.listSkillEvalCases("s1")).toEqual([c]);
    expect(await store.listSkillEvalCases("none")).toEqual([]);

    const run = await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    expect(run).toMatchObject({ status: "running", finished_at: null });
    expect(await store.finishSkillEvalRun("r1", "passed")).toBe(true);
    expect(await store.finishSkillEvalRun("r1", "failed")).toBe(false);
    expect(await store.finishSkillEvalRun("nope", "failed")).toBe(false);

    const replay = await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", verdict: "pass", detail: { note: "ok" } });
    expect(replay).toMatchObject({ verdict: "pass", detail: { note: "ok" } });
    expect(await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", verdict: "fail", detail: null })).toEqual(replay);
    expect(await store.listSkillEvalReplays("r1")).toEqual([replay]);
  });
});
