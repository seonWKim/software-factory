import { describe, expect, it } from "vitest";
import { checkTestFiles, parseTriage } from "../src/core/outputs.js";
import { answersYes, dependencyQuestion, proposedDependency } from "../src/core/task-build.js";
import { triageSpec } from "./helpers/fakes/config.js";

// Triage's dependency proposal (design 04-triage, 2026-11-20): a request that says it runs after another local item is
// asked as "Depends on wi_X? yes/no", a yes/no decision whatever options triage wrote; an approved yes writes the edge.

const decision = (d: Record<string, unknown>) => ({ ...triageSpec, decisions: [{ reason: "the request says it runs after it merges", owner_only: false, ...d }] });

describe("the dependency proposal", () => {
  it("is asked as `Depends on <id>? yes/no`, and only that question names an id", () => {
    expect(dependencyQuestion("wi_288c")).toBe("Depends on wi_288c? yes/no");
    expect(proposedDependency("Depends on wi_288c? yes/no")).toBe("wi_288c");
    expect(proposedDependency("depends on tk_ab-1?  yes/no")).toBe("tk_ab-1");
    for (const q of ["Start now, or wait for wi_288c?", "Depends on wi_288c?", "Depends on #12? yes/no"]) expect(proposedDependency(q), q).toBeNull();
  });

  it("parses as a yes/no decision whatever options triage gave, its default kept", () => {
    for (const options of [[], ["wait", "start now"], ["yes", "no"]]) {
      const p = parseTriage(decision({ question: dependencyQuestion("wi_288c"), options, default: "yes" }));
      expect(p.ok && p.value.decision_items, JSON.stringify(options)).toEqual([
        expect.objectContaining({ text: "Depends on wi_288c? yes/no", options: ["yes", "no"], default: "yes", owner_only: false }),
      ]);
    }
  });

  it("refuses a default other than yes or no", () => {
    expect(parseTriage(decision({ question: dependencyQuestion("wi_288c"), options: [], default: "wait" }))).toEqual({ ok: false, error: "decisions[0].default: must be one of the options" });
  });

  it("a free-text decision is left as it is", () => {
    const p = parseTriage(decision({ question: "Start now, or wait for wi_288c?", options: [], default: "wait" }));
    expect(p.ok && p.value.decision_items).toEqual([expect.objectContaining({ text: "Start now, or wait for wi_288c?", default: "wait" })]);
    expect(p.ok && p.value.decision_items?.[0]).not.toHaveProperty("options");
  });

  it("an answer is yes when it starts with the word yes", () => {
    for (const a of ["yes", "Yes", " yes, wait for it"]) expect(answersYes(a), a).toBe(true);
    for (const a of ["no", "yesterday", "", null]) expect(answersYes(a), String(a)).toBe(false);
  });
});

// Goal lines of a split (design 04-split-specs, 2026-11-22): an optional goal_done_when list, read only on a split spec.
describe("goal_done_when", () => {
  const phase = (n: number) => ({ title: `Part ${n}`, problem: `Problem ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] });
  const split = { ...triageSpec, phases: [phase(1), phase(2)] };

  it("a split keeps its goal lines in order", () => {
    const p = parseTriage({ ...split, goal_done_when: ["the whole flow works", "the docs say so"] });
    expect(p.ok && p.value.goal_done_when).toEqual(["the whole flow works", "the docs say so"]);
  });

  it("absent or empty is no goal, with or without phases", () => {
    for (const spec of [split, { ...split, goal_done_when: [] }, triageSpec, { ...triageSpec, goal_done_when: [] }]) {
      const p = parseTriage(spec);
      expect(p.ok, JSON.stringify(spec)).toBe(true);
      expect(p.ok && p.value).not.toHaveProperty("goal_done_when");
    }
  });

  it("goal lines with no phases are an invalid answer", () => {
    const p = parseTriage({ ...triageSpec, goal_done_when: ["the whole flow works"] });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/^goal_done_when: /);
  });

  it("refuses a list that is not of non-empty strings, and tool-call markup", () => {
    for (const goal of ["one line", [1], ["  "]]) {
      const p = parseTriage({ ...split, goal_done_when: goal });
      expect(!p.ok && p.error, JSON.stringify(goal)).toMatch(/^goal_done_when: /);
    }
    const p = parseTriage({ ...split, goal_done_when: ["<invoke name=\"x\">"] });
    expect(!p.ok && p.error).toMatch(/^goal_done_when: tool-call markup/);
  });
});

// Triage checks the spec's test file names against the repo's files (design 04-pre-push-gates, 2026-11-24): an unknown
// allowed_paths or files_to_change name is replaced by the closest existing test file, named in a decision; with none
// close it stays, a file the run creates. A done-check test file is never swapped (design 04-triage, 2026-11-24).
describe("checkTestFiles", () => {
  const FILES = ["tests/data-table-docs.test.ts", "tests/outputs.test.ts"];
  const LINE = "tests/table-docs.test.ts shows the table docs";
  const spec = (o: Record<string, unknown> = {}) => ({
    ...triageSpec, done_criteria: [LINE, "the docs say so"],
    done_checks: [{ line: LINE, test_file: "tests/table-docs.test.ts" }, { line: "the docs say so", manual: true, reason: "a person reads them" }],
    allowed_paths: ["src/", "tests/table-docs.test.ts", "tests/outputs.test.ts", "tests/new/"], files_to_change: ["src/", "tests/table-docs.test.ts"], ...o,
  });

  it("never swaps a missing done-check test file, unmarked or marked new, for a close existing one, nor where else it is named", () => {
    const unmarked = spec();
    expect(checkTestFiles(unmarked, FILES)).toEqual({ answer: unmarked, refusal: expect.stringContaining("not marked new: true: tests/table-docs.test.ts") });
    const marked = spec({ done_checks: [{ line: LINE, test_file: "tests/table-docs.test.ts", new: true }, unmarked.done_checks[1]] });
    expect(checkTestFiles(marked, FILES)).toEqual({ answer: marked, refusal: null });
  });

  it("replaces a missing allowed_paths test file that no done check names everywhere it is named, and names the swap in a decision", () => {
    const line = "tests/table-docs.test.ts is updated";
    const p = parseTriage(checkTestFiles(spec({ done_criteria: [line, "the docs say so"], done_checks: undefined }), FILES).answer);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.done_criteria[0]).toBe("tests/data-table-docs.test.ts is updated");
    expect(p.value.allowed_paths).toEqual(["src/", "tests/data-table-docs.test.ts", "tests/outputs.test.ts", "tests/new/"]);
    expect(p.value.files_to_change).toEqual(["src/", "tests/data-table-docs.test.ts"]);
    expect(p.value.decision_items).toEqual([expect.objectContaining({ owner_only: false, default: "keep the swap" })]);
    expect(p.value.decision_items?.[0]?.text).toContain("`tests/table-docs.test.ts`, which does not exist; it now names `tests/data-table-docs.test.ts`");
  });

  it("checks an exact tests/ file in allowed_paths or files_to_change too, keeping the decisions triage wrote first", () => {
    const own = { question: "Which colour?", reason: "it shows", options: [], default: "red", owner_only: false };
    const p = parseTriage(checkTestFiles(spec({ done_checks: undefined, decisions: [own], allowed_paths: ["src/", "tests/outputs-triage.test.ts"], files_to_change: ["tests/outputs-triage.test.ts"] }), FILES).answer);
    expect(p.ok && p.value.allowed_paths).toEqual(["src/", "tests/outputs.test.ts"]);
    expect(p.ok && p.value.decision_items?.map((d) => d.text)).toEqual(["Which colour?", expect.stringContaining("it now names `tests/outputs.test.ts`")]);
  });

  it("keeps a missing name no file is close to, with no decision: a file the run creates", () => {
    const v = spec({ done_checks: undefined, allowed_paths: ["tests/zzz.test.ts"], files_to_change: ["tests/zzz.test.ts"] });
    expect(checkTestFiles(v, FILES)).toEqual({ answer: v, refusal: null });
  });

  it("leaves an answer whose test files all exist, and folders, as they are", () => {
    const v = spec({ done_checks: undefined, allowed_paths: ["tests/", "tests/outputs.test.ts", "tests/new/"], files_to_change: ["tests/outputs.test.ts"] });
    expect(checkTestFiles(v, FILES)).toEqual({ answer: v, refusal: null });
  });
});
