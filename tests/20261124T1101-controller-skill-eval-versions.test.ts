import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261124T1101-controller-skill-eval-versions.migration.js";
import type { UserId } from "../src/core/types.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// Every column of "Versioned runs and compare": run versions, the suite version, replay figures and case seed / MCP.
// Additive, rerun-safe, and a run stored before it reads null in each version: no backfill.

const ID = "20261124T1101-controller-skill-eval-versions";
const COLUMNS: Record<string, string[]> = {
  controller_skill_eval_runs: ["suite_version", "judge_version", "factory_version"],
  controller_skill_eval_suites: ["version"],
  controller_skill_eval_replays: ["transcript", "answer", "input_tokens", "output_tokens", "cost_usd", "wall_ms"],
  controller_skill_eval_cases: ["seed", "mcp"],
};
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const OWNER = "local:owner" as UserId;

describe(ID, () => {
  it("adds every column, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    for (const [table, columns] of Object.entries(COLUMNS)) expect(await tableColumns(mdb(db), table)).toEqual(expect.arrayContaining(columns));
  });

  it("leaves a run stored before it with null versions: no backfill", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "t", created_by: OWNER });
    await store.db.run("INSERT INTO controller_skill_eval_runs (id, suite_id, status, started_at, created_by) VALUES ('old', 's1', 'passed', 't', ?)", [OWNER]);
    await migration.up(mdb(store.db));
    expect(await store.getSkillEvalRun("old")).toMatchObject({ id: "old", suite_version: null, judge_version: null, factory_version: null });
  });
});
