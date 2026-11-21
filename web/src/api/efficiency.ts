// Health's Efficiency tab (design 06-efficiency): GET /api/v1/efficiency, finished items per hour, day and week, and
// each week's token and time figures per finished item, and the per-tier merge record. Null figures mean no data, never 0.

import { useApi } from "./client.js";

export const EFFICIENCY_API = "/api/v1/efficiency";

export interface EfficiencyBar { start: string; count: number }
export interface EfficiencyChart { bars: EfficiencyBar[]; total: number }

/** Median and 90th percentile (null: no data), their change in whole percent (null: none), items not counted. */
export interface EfficiencyFigure {
  median: number | null;
  p90: number | null;
  median_change: number | null;
  p90_change: number | null;
  not_counted: number;
}

export interface EfficiencyItem {
  work_item_id: string;
  title: string | null;
  merged_at: string;
  total_ms: number;
  agent_ms: number | null;
  waiting_ms: number | null;
  tokens: number | null;
  cost_usd: number | null;
  runs_without_usage: number;
}

export interface EfficiencyWeek {
  /** Monday of the week (YYYY-MM-DD). */
  start: string;
  /** The week still running. */
  current: boolean;
  finished: number;
  finished_change: number | null;
  tokens: EfficiencyFigure;
  total: EfficiencyFigure;
  agent: EfficiencyFigure;
  waiting: EfficiencyFigure;
  slowest: EfficiencyItem[];
  costliest: EfficiencyItem[];
}

/** One tier's merge record (tier null: untiered) and the auto-merge rule's result; read-only, nothing merges on it. */
export interface EfficiencyTierMerges {
  tier: number | null;
  /** Merges in the last 30 days. */
  merged: number;
  reverted_or_fixed: number;
  /** Explicit owner verdicts other than accept on those merges. */
  not_accept: number;
  /** The merges the rule read: the tier's last 50 at most. */
  sample: number;
  sample_bad: number;
  sample_critical: number;
  rule: "met" | "not_met" | "too_few" | "never";
  qualifies: boolean;
}

export interface EfficiencyView {
  as_of: string;
  hours: EfficiencyChart;
  days: EfficiencyChart;
  weeks: EfficiencyChart;
  /** Oldest first; the current week last. */
  week_figures: EfficiencyWeek[];
  left_out: { total: number; cancelled: number; rejected: number; failed: number };
  runs_without_usage: number;
  /** Tiers 1–5, then untiered. */
  merges: EfficiencyTierMerges[];
}

/** The figures, read again every minute while the tab is open. */
export const useEfficiency = () => useApi<EfficiencyView>(EFFICIENCY_API, 60_000);
