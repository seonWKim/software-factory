import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261123T1300-controller-skill-improve.migration.js";
import { type MigrationDb, MIGRATIONS_TABLE, type SqlDriver, tableColumns } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// controller_skill_drafts and controller_skill_draft_days (design 07-self-improvement, skill improvement): additive
// (two new tables, no backfill) and safe to run twice.

const ID = "20261123T1300-controller-skill-improve";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(ID, () => {
  it("creates the two tables, is additive and safe to run twice", async () => {
    const { store } = await newStore();
    const db = store.db;
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
    expect(migration.tables).toEqual(expect.arrayContaining(["controller_skill_drafts", "controller_skill_draft_days"]));
    await store.addSkillDraft({ id: "d1", project_key: "p", skill_ref: "skills/a", state: "tried", tokens: 1, detail: {} });
    await migration.up(mdb(db));
    await migration.up(mdb(db));
    expect(await tableColumns(mdb(db), "controller_skill_drafts")).toEqual(expect.arrayContaining(["id", "project_key", "skill_ref", "state", "tokens", "detail", "created_at", "updated_at"]));
    expect(await tableColumns(mdb(db), "controller_skill_draft_days")).toEqual(expect.arrayContaining(["project_key", "day", "count"]));
    expect((await store.listSkillDrafts("p")).map((d) => d.id)).toEqual(["d1"]);
  });

  it("backfills nothing", async () => {
    const { store } = await newStore();
    expect(await store.db.all("SELECT id FROM controller_skill_drafts")).toEqual([]);
    expect(await store.db.all("SELECT day FROM controller_skill_draft_days")).toEqual([]);
  });
});
