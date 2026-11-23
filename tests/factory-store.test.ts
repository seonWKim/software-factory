// SkillDraftStore is part of FactoryStore (design 07-self-improvement, skill improvement): the interface extends it,
// and SqlFactoryStore gets its methods through SqlSkillDraftStore (src/impl/store/sql/skill-drafts.ts), which sits
// in the store's base class chain above SqlSkillEvalStore.

import { describe, expect, expectTypeOf, it } from "vitest";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqlSkillDraftStore } from "../src/impl/store/sql/skill-drafts.js";
import { SqlSkillEvalStore } from "../src/impl/store/sql/skill-evals.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SkillDraftStore } from "../src/interfaces/skill-draft-store.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const METHODS = ["addSkillDraft", "getSkillDraft", "listSkillDrafts", "setSkillDraftState", "takeSkillDraftSlot", "skillDraftCount"] as const;

describe("FactoryStore includes SkillDraftStore", () => {
  it("a FactoryStore is a SkillDraftStore (type level)", () => {
    expectTypeOf<FactoryStore>().toMatchTypeOf<SkillDraftStore>();
  });

  it("SqlFactoryStore reaches the draft methods through SqlSkillDraftStore, which extends SqlSkillEvalStore", () => {
    expect(SqlFactoryStore.prototype).toBeInstanceOf(SqlSkillDraftStore);
    expect(Object.getPrototypeOf(SqlSkillDraftStore.prototype)).toBe(SqlSkillEvalStore.prototype);
    for (const m of METHODS) {
      expect(Object.prototype.hasOwnProperty.call(SqlSkillDraftStore.prototype, m), m).toBe(true);
      // Not overridden lower in the chain: the store's method is SqlSkillDraftStore's.
      expect(SqlFactoryStore.prototype[m], m).toBe(SqlSkillDraftStore.prototype[m]);
    }
  });

  it("a migrated SqlFactoryStore serves the draft methods against its own tables", async () => {
    const { store } = await newStore();
    const asDrafts: SkillDraftStore = store;
    await asDrafts.addSkillDraft({ id: "d1", project_key: PROJECT_KEY, skill_ref: "skills/a", state: "tried", tokens: 5, detail: {} });
    expect((await asDrafts.listSkillDrafts(PROJECT_KEY)).map((d) => d.id)).toEqual(["d1"]);
    expect(await asDrafts.takeSkillDraftSlot(PROJECT_KEY, 1)).toBe(true);
    expect(await asDrafts.skillDraftCount(PROJECT_KEY)).toBe(1);
  });
});
