// Controller table docs (src/controller/table-docs.ts): one line for each skill improvement table
// (design 07-self-improvement). tests/data-table-docs.test.ts checks every table generally; this names the two new ones.

import { describe, expect, it } from "vitest";
import { TABLE_DOCS } from "../src/controller/table-docs.js";
import { tableDoc } from "../src/ui/data.js";

const NEW_TABLES = ["controller_skill_drafts", "controller_skill_draft_days"] as const;

describe("controller table docs: skill improvement tables", () => {
  it("has exactly one table line for each new table, a single sentence", () => {
    for (const t of NEW_TABLES) {
      expect(Object.keys(TABLE_DOCS).filter((k) => k === t), t).toHaveLength(1);
      expect(TABLE_DOCS[t], t).toMatch(/^\S[^\n]*\.$/);
    }
  });

  it("the drafts line names the five states; the days line says one row per project and UTC day", () => {
    for (const s of ["tried", "proposed", "promoted", "rejected", "held"]) expect(TABLE_DOCS.controller_skill_drafts).toContain(s);
    expect(TABLE_DOCS.controller_skill_draft_days).toMatch(/project/);
    expect(TABLE_DOCS.controller_skill_draft_days).toMatch(/UTC day/);
  });

  it("the Data page reads both lines with the controller as owner", () => {
    for (const t of NEW_TABLES) expect(tableDoc(t), t).toMatchObject({ owner: "controller", description: TABLE_DOCS[t] });
  });
});
