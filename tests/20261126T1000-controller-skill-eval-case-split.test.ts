import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261126T1000-controller-skill-eval-case-split.migration.js";
import type { UserId } from "../src/core/types.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The split of a skill eval case (design 07-self-improvement): controller_skill_eval_cases gets split (TEXT, NOT NULL,
// default dev, dev or held-out); no case is backfilled, so a stored case reads dev, and a rerun changes nothing. The
// store reads and writes it and sets it with one method that bumps no suite version.

const ID = "20261126T1000-controller-skill-eval-case-split";
const OWNER = "local:owner" as UserId;
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(ID, () => {
  it("a fresh store has split TEXT NOT NULL defaulting to dev, and the migration recorded", async () => {
    const { store } = await newStore();
    const [col] = await store.db.all("SELECT type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('controller_skill_eval_cases') WHERE name = 'split'");
    expect(col).toEqual({ type: "TEXT", nn: 1, d: "'dev'" });
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: expect.arrayContaining(["controller_skill_eval_cases"]) });
  });

  it("backfills no case: a stored case reads dev, every other column keeps its data, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_skill_eval_cases DROP COLUMN split");
    await db.run("INSERT INTO controller_skill_eval_cases (id, suite_id, input, expected, created_at, seed, mcp) VALUES ('c1', 's1', '\"in\"', '[\"a\"]', '2026-11-26T00:00:00.000Z', 'seeds/x', '[\"m\"]')");
    const before = await db.all("SELECT * FROM controller_skill_eval_cases");
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_skill_eval_cases")).toEqual(before.map((r) => ({ ...r, split: "dev" })));
    await expect(db.run("UPDATE controller_skill_eval_cases SET split = 'other' WHERE id = 'c1'")).rejects.toThrow();
  });

  it("the store reads a case's split, dev when none is given, and sets it with no suite version bump; an unknown case gives null", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "k", title: "t", created_by: OWNER });
    expect(await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: ["a"] })).toMatchObject({ split: "dev" });
    expect(await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "y", expected: ["a"], split: "held-out" })).toMatchObject({ split: "held-out" });
    const version = async () => (await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = 's1'"))[0]!.version;
    const v = await version();

    expect(await store.setSkillEvalCaseSplit("c1", "held-out")).toMatchObject({ id: "c1", split: "held-out" });
    expect(await store.setSkillEvalCaseSplit("c2", "dev")).toMatchObject({ id: "c2", split: "dev" });
    expect(await store.setSkillEvalCaseSplit("none", "dev")).toBeNull();
    expect(await version()).toBe(v);
    expect((await store.listSkillEvalCases("s1")).map((c) => [c.id, c.split])).toEqual([["c1", "held-out"], ["c2", "dev"]]);
  });
});
