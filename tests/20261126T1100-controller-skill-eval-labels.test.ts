import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261126T1100-controller-skill-eval-labels.migration.js";
import type { UserId } from "../src/core/types.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The owner's labels on the judge (design 06-measurement, judge labels): controller_skill_eval_labels is a new table,
// additive and rerun-safe; no label or case split is backfilled.

const ID = "20261126T1100-controller-skill-eval-labels";
const COLUMNS = ["run_id", "case_id", "replay", "check_text", "verdict", "owner_id", "created_at"];
const OWNER = "local:owner" as UserId;
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(ID, () => {
  it("creates controller_skill_eval_labels, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: ["controller_skill_eval_labels"] });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await tableColumns(mdb(db), "controller_skill_eval_labels")).toEqual(expect.arrayContaining(COLUMNS));
  });

  it("keys a label on run, case, replay and check, and takes only right or wrong as its verdict", async () => {
    const { store } = await newStore();
    const insert = (verdict: string) =>
      store.db.run("INSERT INTO controller_skill_eval_labels (run_id, case_id, replay, check_text, verdict, owner_id, created_at) VALUES ('r', 'c', 1, 'k', ?, ?, 't')", [verdict, OWNER]);
    await expect(insert("maybe")).rejects.toThrow();
    await insert("right");
    await expect(insert("wrong")).rejects.toThrow();
  });

  it("backfills no label and changes no case split", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "A", created_by: OWNER });
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: ["a"] });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", replay: 1, verdict: "fail", detail: { answers: [{ check: "k", answer: "no" }] } });
    const cases = await store.db.all("SELECT * FROM controller_skill_eval_cases");
    await migration.up(mdb(store.db));
    expect(await store.db.all("SELECT * FROM controller_skill_eval_labels")).toEqual([]);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_cases")).toEqual(cases);
  });
});
