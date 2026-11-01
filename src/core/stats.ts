import type { StatsConfig } from "./config.js";
import type { Stage, Tier, VerdictSeverity, WorkItemId } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

// Per-tier human-correction numbers for `factory stats` (design §6 Measurement). Read-only: nothing here
// writes, and no dial reads these numbers.

/** The state_changes reasons a human command writes when it is applied. A refused command writes none. */
export const STATS_REASONS = { reject: "spec_rejected", retry: "retry_requested" } as const;

/** One work item as the stats need it: no title, problem or display name. */
export interface StatsRecord {
  id: WorkItemId;
  tier: Tier | null;
  stage: Stage;
  token_cost: number;
  /** One entry per state change whose reason is one of the requested reasons. */
  reasons: string[];
  /** One entry per `/verdict` on the item. */
  severities: VerdictSeverity[];
}

export interface StatsRow {
  /** 1–5, or null for items with no tier (the `untiered` row). */
  tier: Tier | null;
  /** CLOSED items in this tier (merged, rejected or otherwise closed). */
  items: number;
  /** Sum of the configured weights of every verdict on those items. */
  feedback_weight: number;
  /** feedback_weight ÷ items; null when `sufficient` is false. */
  rate: number | null;
  /** items ≥ min_sample. */
  sufficient: boolean;
  /** Applied `/reject` (spec_rejected state changes) on those items. */
  reject: number;
  /** Applied `/retry` (retry_requested state changes) on those items. */
  retry: number;
  token_cost: number;
}

export interface StatsReport {
  config: StatsConfig;
  tiers: StatsRow[];
}

export const STATS_TIERS: readonly (Tier | null)[] = [1, 2, 3, 4, 5, null];

/** Pure: one row per tier 1–5 plus untiered, over CLOSED items only. */
export function aggregateStats(records: readonly StatsRecord[], config: StatsConfig): StatsRow[] {
  return STATS_TIERS.map((tier) => {
    const closed = records.filter((r) => r.tier === tier && r.stage === "CLOSED");
    const items = closed.length;
    const feedback_weight = sum(closed.flatMap((r) => r.severities.map((s) => config.weights[s])));
    const sufficient = items >= config.min_sample;
    return {
      tier,
      items,
      feedback_weight,
      rate: sufficient ? feedback_weight / items : null,
      sufficient,
      reject: sum(closed.map((r) => r.reasons.filter((x) => x === STATS_REASONS.reject).length)),
      retry: sum(closed.map((r) => r.reasons.filter((x) => x === STATS_REASONS.retry).length)),
      token_cost: sum(closed.map((r) => r.token_cost)),
    };
  });
}

/** Reads through the one read-only store method; the narrow type keeps every write method out of reach. */
export async function collectStats(store: Pick<FactoryStore, "listStatsRecords">, config: StatsConfig): Promise<StatsReport> {
  const records = await store.listStatsRecords([STATS_REASONS.reject, STATS_REASONS.retry]);
  return { config, tiers: aggregateStats(records, config) };
}

export function tierLabel(tier: Tier | null): string {
  return tier === null ? "untiered" : String(tier);
}

/** The text table for `factory stats`. */
export function formatStatsText(report: StatsReport): string {
  const header = ["tier", "items", "feedback", "rate", "/reject", "/retry", "token_cost"];
  const rows = report.tiers.map((r) => [
    tierLabel(r.tier),
    String(r.items),
    String(r.feedback_weight),
    r.rate === null ? "not enough data" : r.rate.toFixed(2),
    String(r.reject),
    String(r.retry),
    String(r.token_cost),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const w = report.config.weights;
  return [
    line(header),
    ...rows.map(line),
    "",
    `items: CLOSED work items per tier. rate: feedback ÷ items, shown from min_sample ${report.config.min_sample} items.`,
    `weights: none ${w.none}, minor ${w.minor}, major ${w.major}, critical ${w.critical}.`,
    "/reject and /retry count applied commands only (spec_rejected, retry_requested); refused commands are not counted.",
  ].join("\n");
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
