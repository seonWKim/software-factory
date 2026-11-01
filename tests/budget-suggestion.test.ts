import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MIN_SAMPLE,
  budgetConfig,
  checkpointComment,
  currentBudget,
  nearestRankPercentile,
  overBudget,
  parseBudgetAmount,
  suggestBudget,
  tierBudget,
} from "../src/core/budget.js";
import { loadConfig } from "../src/compose.js";
import { settingValues, settingsLayers } from "../src/core/settings.js";

/** The global budgets a config with these top-level keys gives (settingsLayers checks them). */
function budgetsOf(raw: Record<string, unknown>) {
  return settingValues("o/n", settingsLayers(raw, "o/n")).budgets;
}

// Design §6 budgets: the limit check, the suggestion (base rule and history percentile), the checkpoint text.

describe("budget config", () => {
  it("no budgets key means no limits for any tier; budget_min_sample defaults to 10", () => {
    expect(budgetConfig({})).toEqual({ budget_min_sample: 10 });
    expect(DEFAULT_BUDGET_MIN_SAMPLE).toBe(10);
    const budgets = budgetsOf({});
    expect(budgets).toEqual({});
    for (const t of [1, 2, 3, 4, 5] as const) expect(tierBudget(budgets, t)).toBeNull();
    expect(tierBudget(undefined, 2)).toBeNull();
  });

  it("parses tier keys 1 to 5 with positive integer budgets", () => {
    expect(budgetConfig({ budget_min_sample: 3 })).toEqual({ budget_min_sample: 3 });
    const budgets = budgetsOf({ budgets: { "2": 1_000_000, "5": 3_000_000 } });
    expect(budgets).toEqual({ 2: 1_000_000, 5: 3_000_000 });
    expect(tierBudget(budgets, 2)).toBe(1_000_000);
    expect(tierBudget(budgets, 1)).toBeNull();
  });

  it("fails when a key is not tier 1 to 5", () => {
    for (const k of ["0", "6", "1.5", "two", "-1", ""]) {
      expect(() => budgetsOf({ budgets: { [k]: 100 } })).toThrow(/budgets/);
    }
    expect(() => budgetsOf({ budgets: [100] })).toThrow(/budgets/);
    expect(() => budgetsOf({ budgets: null })).toThrow(/budgets/);
  });

  it("fails when a budget is not a positive integer", () => {
    for (const v of [0, -5, 1.5, "100", null, Number.NaN]) {
      expect(() => budgetsOf({ budgets: { "1": v } })).toThrow(/budgets\.1/);
    }
  });

  it("fails when budget_min_sample is not an integer of at least 1", () => {
    for (const v of [0, -1, 2.5, "10", null]) {
      expect(() => budgetConfig({ budget_min_sample: v })).toThrow(/budget_min_sample/);
    }
  });

  it("factory.config.json has no budgets and still loads: no limits, min sample 10", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const file = JSON.parse(readFileSync(`${root}factory.config.json`, "utf8")) as Record<string, unknown>;
    expect(file.budgets).toBeUndefined();
    const { config } = await loadConfig(root);
    expect(settingValues("seonWKim/software-factory", config.settings).budgets).toEqual({});
    expect(config.budget_min_sample).toBe(10);
  });
});

describe("the limit", () => {
  it("is reached at or over the budget", () => {
    expect(overBudget(999, 1000)).toBe(false);
    expect(overBudget(1000, 1000)).toBe(true);
    expect(overBudget(1001, 1000)).toBe(true);
  });

  it("current budget: the latest granted budget, else the tier's configured budget", () => {
    expect(currentBudget(1000, [])).toBe(1000);
    expect(currentBudget(1000, [{ granted_budget: 5000 }, { granted_budget: null }])).toBe(5000);
    expect(currentBudget(1000, [{ granted_budget: 5000 }, { granted_budget: 7000 }])).toBe(7000);
    // A tier raised after a grant never gets less than its own configured budget.
    expect(currentBudget(9000, [{ granted_budget: 5000 }])).toBe(9000);
  });
});

describe("the suggestion", () => {
  const base = 1_000_000;

  it("before budget_min_sample finished items: current budget plus the tier's configured budget", () => {
    const s = suggestBudget({ current: 2_000_000, base, history: { finished: 9, merged_token_costs: [5_000_000] }, min_sample: 10 });
    expect(s).toMatchObject({ budget: 3_000_000, method: "base", merged_sample: 0, replaced: false });
    expect(s.note).toMatch(/9 finished/);
  });

  it("with enough finished items: nearest-rank p90 of merged token_cost, rounded up to the next 100000", () => {
    // 10 merged: rank ceil(0.9 × 10) = 9 → the 9th smallest.
    const costs = [9_999_999, 100_000, 200_000, 300_000, 1_234_567, 400_000, 500_000, 600_000, 700_000, 800_000];
    const s = suggestBudget({ current: 1_000_000, base, history: { finished: 12, merged_token_costs: costs }, min_sample: 10 });
    expect(s).toMatchObject({ budget: 1_300_000, method: "history", merged_sample: 10, replaced: false });
  });

  it("an exact multiple of 100000 stays as it is", () => {
    const s = suggestBudget({ current: 100_000, base, history: { finished: 1, merged_token_costs: [2_000_000] }, min_sample: 1 });
    expect(s.budget).toBe(2_000_000);
  });

  it("a history suggestion not above the current budget is replaced by the base rule, and says so", () => {
    const s = suggestBudget({ current: 3_000_000, base, history: { finished: 10, merged_token_costs: Array(10).fill(2_950_000) }, min_sample: 10 });
    expect(s).toMatchObject({ budget: 4_000_000, method: "base", merged_sample: 10, replaced: true });
    expect(s.note).toMatch(/3000000/);
  });

  it("enough finished items but none merged: the base rule, and it says so", () => {
    const s = suggestBudget({ current: 1_000_000, base, history: { finished: 10, merged_token_costs: [] }, min_sample: 10 });
    expect(s).toMatchObject({ budget: 2_000_000, method: "base", merged_sample: 0, replaced: false });
    expect(s.note).toMatch(/no merged/);
  });

  it("nearest rank", () => {
    expect(nearestRankPercentile([5], 90)).toBe(5);
    expect(nearestRankPercentile([3, 1, 2], 90)).toBe(3);
    expect(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10);
    expect(nearestRankPercentile(Array.from({ length: 20 }, (_, i) => i + 1), 90)).toBe(18);
  });
});

describe("/budget amounts", () => {
  it("no number continues with the suggestion", () => {
    expect(parseBudgetAmount(null, 1000)).toEqual({ ok: true, value: null });
    expect(parseBudgetAmount("", 1000)).toEqual({ ok: true, value: null });
  });

  it("a whole number above the current budget", () => {
    expect(parseBudgetAmount("9000000", 1000)).toEqual({ ok: true, value: 9_000_000 });
    expect(parseBudgetAmount("1001", 1000)).toEqual({ ok: true, value: 1001 });
  });

  it("refuses anything else", () => {
    for (const a of ["1.5", "9,000,000", "-5", "1e7", "lots", "0x10", "99999999999999999999"]) {
      expect(parseBudgetAmount(a, 1000)).toMatchObject({ ok: false, refuse: expect.stringMatching(/whole number/) });
    }
    expect(parseBudgetAmount("1000", 1000)).toMatchObject({ ok: false, refuse: expect.stringMatching(/greater than the current budget/) });
    expect(parseBudgetAmount("10", 1000)).toMatchObject({ ok: false });
  });
});

describe("the checkpoint comment", () => {
  it("has the stage, PR, runs and tokens, budget, suggestion, method, sample and how to answer", () => {
    const body = checkpointComment({
      tier: 2,
      stage: "REVIEW",
      pr_number: 42,
      runs: 4,
      tokens: 1_050_000,
      budget: 1_000_000,
      held_run_kind: "review",
      suggestion: { budget: 1_300_000, method: "history", merged_sample: 10, replaced: false, note: null },
    });
    expect(body).toContain("`REVIEW`");
    expect(body).toContain("PR #42");
    expect(body).toContain("4 runs");
    expect(body).toContain("1050000 tokens");
    expect(body).toContain("Current budget: 1000000 tokens");
    expect(body).toContain("Suggested budget: 1300000 tokens");
    expect(body).toMatch(/90th percentile/);
    expect(body).toMatch(/10 merged/);
    expect(body).toContain("`/budget`");
    expect(body).toContain("`/budget <tokens>`");
    expect(body).toContain("`/reject <reason>`");
  });

  it("without a PR says so, and the base rule names its method, sample and note", () => {
    const body = checkpointComment({
      tier: 3,
      stage: "RUNNING",
      pr_number: null,
      runs: 2,
      tokens: 500,
      budget: 400,
      held_run_kind: "implement",
      suggestion: { budget: 800, method: "base", merged_sample: 0, replaced: true, note: "history said 300 tokens, not above 400" },
    });
    expect(body).toContain("no PR yet");
    expect(body).toMatch(/base rule/);
    expect(body).toMatch(/0 merged/);
    expect(body).toContain("history said 300 tokens, not above 400");
  });
});
