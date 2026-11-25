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

describe("controller table docs: skill eval version columns", () => {
  const COLUMNS = [
    "controller_skill_eval_runs.suite_version", "controller_skill_eval_runs.judge_version", "controller_skill_eval_runs.factory_version",
    "controller_skill_eval_suites.version",
    "controller_skill_eval_replays.transcript", "controller_skill_eval_replays.answer", "controller_skill_eval_replays.input_tokens",
    "controller_skill_eval_replays.output_tokens", "controller_skill_eval_replays.cost_usd", "controller_skill_eval_replays.wall_ms",
    "controller_skill_eval_cases.seed", "controller_skill_eval_cases.mcp",
    "controller_skill_eval_replays.replay",
  ];

  it("describes every column the versions migration adds, one sentence each", () => {
    for (const c of COLUMNS) expect(TABLE_DOCS[c], c).toMatch(/^\S[^\n]*\.$/);
  });
});

describe("controller table docs: judge labels", () => {
  const COLUMNS = ["run_id", "case_id", "replay", "check_text", "verdict", "owner_id", "created_at"];

  it("describes controller_skill_eval_labels and each of its columns, one sentence each", () => {
    expect(TABLE_DOCS.controller_skill_eval_labels).toMatch(/^\S[^\n]*\.$/);
    for (const c of COLUMNS) expect(TABLE_DOCS[`controller_skill_eval_labels.${c}`], c).toMatch(/^\S[^\n]*\.$/);
    expect(tableDoc("controller_skill_eval_labels")).toMatchObject({ owner: "controller" });
  });
});
