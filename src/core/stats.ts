import type { StatsConfig } from "./config.js";
import type { Stage, Tier, VerdictSeverity, WorkItemId, WorkItemOrigin } from "./types.js";
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
  /** One entry per explicit verdict (`/verdict`) on the item. */
  severities: VerdictSeverity[];
  /** How many implicit verdicts (from PR events) the item has. Absent means 0. */
  implicit?: number;
  /** Absent means `factory`. Adopted items count only in the `adopted` row, never in a tier row. */
  origin?: WorkItemOrigin;
  /** An implicit `changes` verdict (a person's push to the PR) is stored for the item. Absent means false. */
  pushed?: boolean;
  /** The item is CLOSED with close_reason completed. Absent means false. */
  merged?: boolean;
}

/** Autonomy (design §6): the share of merged factory items that merged with no person's push. */
export interface AutonomyReport {
  /** Merged factory items: CLOSED with close_reason completed, not adopted. */
  merged: number;
  /** Of those, the items with a stored push verdict. */
  with_push: number;
  /** (merged − with_push) ÷ merged; null when merged is 0. */
  autonomy: number | null;
}

export interface StatsRow {
  /** 1–5, or null for items with no tier (the `untiered` row). */
  tier: Tier | null;
  /** CLOSED items in this tier (merged, rejected or otherwise closed). */
  items: number;
  /** Explicit verdicts (`/verdict` comments) on those items. */
  explicit: number;
  /** Implicit verdicts (from a merge, a person's push or a revert) on those items. Not in feedback_weight. */
  implicit: number;
  /** Sum of the configured weights of every explicit verdict on those items. */
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
  /** Factory items only, one row per tier 1–5 plus untiered. */
  tiers: StatsRow[];
  /**
   * CLOSED adopted items (changes a person opened, design 2026-11-01), whatever their tier; `tier` is
   * null. Absent in reports built before it existed.
   */
  adopted?: StatsRow;
  /** Merged factory items with no person's push. Absent in reports built before it existed. */
  autonomy?: AutonomyReport;
  /** Finished `interactive` runs (design §5, 2026-11-01), any item, and their reported tokens. Counts only, no ids. */
  interactive?: { runs: number; tokens: number };
}

export const STATS_TIERS: readonly (Tier | null)[] = [1, 2, 3, 4, 5, null];

/** Pure: one row per tier 1–5 plus untiered, over CLOSED factory items only (adopted items are left out). */
export function aggregateStats(records: readonly StatsRecord[], config: StatsConfig): StatsRow[] {
  const factory = records.filter((r) => (r.origin ?? "factory") === "factory");
  return STATS_TIERS.map((tier) => row(tier, factory.filter((r) => r.tier === tier), config));
}

/** Pure: the `adopted` row, over CLOSED adopted items of any tier. */
export function aggregateAdopted(records: readonly StatsRecord[], config: StatsConfig): StatsRow {
  return row(null, records.filter((r) => r.origin === "adopted"), config);
}

function row(tier: Tier | null, records: readonly StatsRecord[], config: StatsConfig): StatsRow {
  const closed = records.filter((r) => r.stage === "CLOSED");
  const items = closed.length;
  const feedback_weight = sum(closed.flatMap((r) => r.severities.map((s) => config.weights[s])));
  const sufficient = items >= config.min_sample;
  return {
    tier,
    items,
    explicit: sum(closed.map((r) => r.severities.length)),
    implicit: sum(closed.map((r) => r.implicit ?? 0)),
    feedback_weight,
    rate: sufficient ? feedback_weight / items : null,
    sufficient,
    reject: sum(closed.map((r) => r.reasons.filter((x) => x === STATS_REASONS.reject).length)),
    retry: sum(closed.map((r) => r.reasons.filter((x) => x === STATS_REASONS.retry).length)),
    token_cost: sum(closed.map((r) => r.token_cost)),
  };
}

/** Pure: Autonomy over merged factory items (adopted items and every other close are left out). */
export function aggregateAutonomy(records: readonly StatsRecord[]): AutonomyReport {
  const merged = records.filter((r) => (r.origin ?? "factory") === "factory" && r.stage === "CLOSED" && r.merged === true);
  const with_push = merged.filter((r) => r.pushed === true).length;
  return { merged: merged.length, with_push, autonomy: merged.length === 0 ? null : (merged.length - with_push) / merged.length };
}

/** Autonomy from one read-only store read; `factory stats` and the dashboard route both call it. */
export async function collectAutonomy(store: Pick<FactoryStore, "listStatsRecords">): Promise<AutonomyReport> {
  return aggregateAutonomy(await store.listStatsRecords([]));
}

/** Reads through read-only store methods; the narrow type keeps every write method out of reach. */
export async function collectStats(store: Pick<FactoryStore, "listStatsRecords" | "listRunsByKind">, config: StatsConfig): Promise<StatsReport> {
  const records = await store.listStatsRecords([STATS_REASONS.reject, STATS_REASONS.retry]);
  const sessions = await store.listRunsByKind("interactive", ["succeeded", "failed"]);
  const interactive = { runs: sessions.length, tokens: sum(sessions.map((r) => r.session_tokens ?? 0)) };
  const autonomy = await collectAutonomy(store);
  return { config, tiers: aggregateStats(records, config), adopted: aggregateAdopted(records, config), autonomy, interactive };
}

/** The one Autonomy line of `factory stats`. */
function formatAutonomy(a: AutonomyReport): string {
  if (a.autonomy === null) return "autonomy: not enough data (no merged factory items)";
  return `autonomy: ${a.autonomy.toFixed(2)} (${a.merged - a.with_push} of ${a.merged} merged factory items with no person's push)`;
}

export function tierLabel(tier: Tier | null): string {
  return tier === null ? "untiered" : String(tier);
}

/** The text table for `factory stats`. */
export function formatStatsText(report: StatsReport): string {
  const header = ["tier", "items", "explicit", "implicit", "feedback", "rate", "/reject", "/retry", "token_cost"];
  const labelled = [
    ...report.tiers.map((r) => ({ label: tierLabel(r.tier), r })),
    ...(report.adopted ? [{ label: "adopted", r: report.adopted }] : []),
  ];
  const rows = labelled.map(({ label, r }) => [
    label,
    String(r.items),
    String(r.explicit),
    String(r.implicit),
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
    ...(report.autonomy ? ["", formatAutonomy(report.autonomy)] : []),
    "",
    `items: CLOSED work items per tier. rate: feedback ÷ items, shown from min_sample ${report.config.min_sample} items.`,
    ...(report.adopted ? ["adopted: CLOSED changes a person opened and the factory adopted, any tier; not in the tier rows."] : []),
    "explicit: /verdict comments; implicit: verdicts read from merges, people's pushes and reverts. feedback weighs explicit verdicts only.",
    `weights: none ${w.none}, minor ${w.minor}, major ${w.major}, critical ${w.critical}.`,
    "/reject and /retry count applied commands only (spec_rejected, retry_requested); refused commands are not counted.",
    ...(report.interactive ? [`interactive sessions: ${report.interactive.runs} finished, ${report.interactive.tokens} tokens reported (factory session).`] : []),
  ].join("\n");
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
