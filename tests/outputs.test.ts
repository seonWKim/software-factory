import { describe, expect, it } from "vitest";
import { parseTriage } from "../src/core/outputs.js";
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
