import type { BudgetCheckpoint, RunKind, Stage, Tier } from "./types.js";

// Token budgets per tier (design §6). Pure: the limit check, the suggested next budget, the checkpoint text.

/** blocked_reason of an item held at a token-budget checkpoint (blocked_on `budget`). */
export const BUDGET_CHECKPOINT = "budget_checkpoint";
export const DEFAULT_BUDGET_MIN_SAMPLE = 10;
/** History suggestions are rounded up to a multiple of this many tokens. */
export const BUDGET_ROUNDING = 100_000;
/** The percentile of merged items' token_cost a history suggestion uses. */
export const BUDGET_PERCENTILE = 90;

export type Budgets = Partial<Record<Tier, number>>;

/**
 * `budgets` (tier → tokens) and `budget_min_sample` from factory.config.json. Absent budgets: no limits.
 * Keys must be tiers 1–5, budgets positive integers, the min sample an integer ≥ 1; otherwise startup fails.
 */
export function budgetConfig(file: { budgets?: unknown; budget_min_sample?: unknown }): {
  budgets: Budgets;
  budget_min_sample: number;
} {
  const budgets: Budgets = {};
  if (file.budgets !== undefined) {
    const b = file.budgets;
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      throw new Error("budgets must be an object of tier (1–5) to tokens");
    }
    for (const [k, v] of Object.entries(b)) {
      if (!/^[1-5]$/.test(k)) throw new Error(`budgets key "${k}" must be a tier from 1 to 5`);
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error(`budgets.${k} must be a positive integer`);
      budgets[Number(k) as Tier] = v;
    }
  }
  const min = file.budget_min_sample === undefined ? DEFAULT_BUDGET_MIN_SAMPLE : file.budget_min_sample;
  if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 1) {
    throw new Error("budget_min_sample must be an integer of at least 1");
  }
  return { budgets, budget_min_sample: min };
}

/** The configured budget of `tier`, or null when it has none (no limit). */
export function tierBudget(budgets: Budgets | undefined, tier: Tier): number | null {
  return budgets?.[tier] ?? null;
}

/** At or over the budget. */
export function overBudget(tokens: number, budget: number): boolean {
  return tokens >= budget;
}

/**
 * The item's current budget: the one granted by its latest answered (continued) checkpoint, else the
 * tier's configured budget. Never below the configured budget, so a tier raised after a grant keeps its own.
 */
export function currentBudget(base: number, checkpoints: readonly Pick<BudgetCheckpoint, "granted_budget">[]): number {
  const granted = checkpoints.filter((c) => c.granted_budget !== null).at(-1)?.granted_budget ?? null;
  return granted === null ? base : Math.max(granted, base);
}

/** Finished (CLOSED) items of a tier, and the token_cost of those that merged (close_reason completed). */
export interface TierHistory {
  finished: number;
  merged_token_costs: number[];
}

export interface Suggestion {
  budget: number;
  /** `history`: the percentile of merged items. `base`: the current budget plus the tier's configured budget. */
  method: "base" | "history";
  /** Merged records the history was read from (0 when it was not read). */
  merged_sample: number;
  /** A history suggestion was not above the current budget and the base rule replaced it. */
  replaced: boolean;
  /** Why the base rule was used, when it was. */
  note: string | null;
}

/**
 * The next budget to offer. Before `min_sample` finished items exist in the tier, or when none merged:
 * current + base. Otherwise the nearest-rank 90th percentile of merged token_cost, rounded up to the next
 * 100000 tokens; if that is not above the current budget, current + base instead.
 */
export function suggestBudget(input: { current: number; base: number; history: TierHistory; min_sample: number }): Suggestion {
  const { current, base, history, min_sample } = input;
  const fallback = current + base;
  if (history.finished < min_sample) {
    return {
      budget: fallback,
      method: "base",
      merged_sample: 0,
      replaced: false,
      note: `the tier has ${history.finished} finished items, fewer than budget_min_sample (${min_sample})`,
    };
  }
  const n = history.merged_token_costs.length;
  if (n === 0) {
    return { budget: fallback, method: "base", merged_sample: 0, replaced: false, note: "the tier has no merged items yet" };
  }
  const p = roundUp(nearestRankPercentile(history.merged_token_costs, BUDGET_PERCENTILE), BUDGET_ROUNDING);
  if (p <= current) {
    return {
      budget: fallback,
      method: "base",
      merged_sample: n,
      replaced: true,
      note: `the history suggestion (${p} tokens from ${n} merged items) was not above the current budget (${current} tokens), so the base rule replaced it`,
    };
  }
  return { budget: p, method: "history", merged_sample: n, replaced: false, note: null };
}

/** Nearest rank: the value at rank ceil(p/100 × n) of the sorted values (1-based). `values` must not be empty. */
export function nearestRankPercentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * The argument of `/budget`: none (continue with the suggestion), or a whole number of tokens greater than
 * the current budget. Anything else is refused with a reason.
 */
export function parseBudgetAmount(
  arg: string | null,
  current: number,
): { ok: true; value: number | null } | { ok: false; refuse: string } {
  const a = (arg ?? "").trim();
  if (a === "") return { ok: true, value: null };
  const n = Number(a);
  if (!/^\d+$/.test(a) || !Number.isSafeInteger(n)) {
    return { ok: false, refuse: `\`${a.slice(0, 40)}\` is not a whole number of tokens` };
  }
  if (n <= current) return { ok: false, refuse: `the new budget must be greater than the current budget (${current} tokens)` };
  return { ok: true, value: n };
}

export interface CheckpointText {
  tier: Tier;
  stage: Stage;
  pr_number: number | null;
  runs: number;
  tokens: number;
  budget: number;
  held_run_kind: RunKind;
  suggestion: Suggestion;
}

/** The one comment a checkpoint posts: where the item is, what it spent, the budget, the suggestion, how to answer. */
export function checkpointComment(c: CheckpointText): string {
  const s = c.suggestion;
  const method = s.method === "history"
    ? `nearest-rank ${BUDGET_PERCENTILE}th percentile of the token cost of ${s.merged_sample} merged tier-${c.tier} items, rounded up to the next ${BUDGET_ROUNDING} tokens`
    : `base rule (current budget plus the tier-${c.tier} budget); ${s.merged_sample} merged records used`;
  return [
    "## Factory budget checkpoint",
    "",
    `This tier-${c.tier} item reached its token budget, so the next ${c.held_run_kind} run was not started. All work so far is kept.`,
    "",
    `- Stage: \`${c.stage}\`, ${c.pr_number === null ? "no PR yet" : `PR #${c.pr_number}`}`,
    `- Spent: ${c.runs} runs, ${c.tokens} tokens`,
    `- Current budget: ${c.budget} tokens`,
    `- Suggested budget: ${s.budget} tokens (${method})`,
    ...(s.note ? [`- Note: ${s.note}`] : []),
    "",
    "Reply with one of:",
    "",
    `- \`/budget\` to continue with the suggested budget (${s.budget} tokens)`,
    "- `/budget <tokens>` to continue with your own budget, a whole number greater than the current budget",
    "- `/reject <reason>` to close the item; the branch and the PR stay as they are",
  ].join("\n");
}
