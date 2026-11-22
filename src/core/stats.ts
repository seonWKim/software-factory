import type { StatsConfig } from "./config.js";
import { type OwnerFigures, ownerFigures } from "./efficiency.js";
import type { MergeEvaluation } from "./merge-evaluation.js";
import { DAY_MS } from "./spend.js";
import type { Stage, Tier, VerdictSeverity, WorkItemId, WorkItemOrigin } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

// Per-tier human-correction numbers and the per-tier merge record for `factory stats` (design §6 Measurement).
// Read-only: nothing here writes, and no dial or merge reads these numbers or the rule.

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
  /** Per-tier merge record and the auto-merge rule, tiers 1–5 plus untiered. Absent in reports built before it existed. */
  merges?: TierMergeRow[];
  /** What the merges of the last 30 days took from the owner (design 06-efficiency). Absent in reports built before it existed. */
  owner?: OwnerFigures;
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

/** The merge window of the per-tier figures: the last 30 days. */
export const MERGE_WINDOW_DAYS = 30;
/** The rule reads each tier's last 50 merges. */
export const TIER_RULE_SAMPLE = 50;
/** The most reverted or fixed-forward merges the rule allows in its sample. */
export const TIER_RULE_MAX_BAD = 1;
/** Tiers that never qualify, whatever their record. */
export const NEVER_QUALIFY: readonly Tier[] = [4, 5];

/** The rule's result: met, not met, too few merges (under the sample), or never (tiers 4 and 5). */
export type TierRuleResult = "met" | "not_met" | "too_few" | "never";

/** The merge figures the rule reads. */
export type RuleMerge = Pick<MergeEvaluation, "reverted" | "fixed_forward" | "critical">;

/** A merge with a revert or a fix-forward. */
const bad = (m: RuleMerge): boolean => m.reverted > 0 || m.fixed_forward > 0;

/**
 * Pure, the one auto-merge rule (design 06-measurement): a tier qualifies when its last 50 merges (`last`, oldest
 * first; only the last 50 are read) hold at most 1 reverted or fixed-forward merge and no critical verdict. Fewer than
 * 50 merges never qualify; tiers 4 and 5 never do. Read-only: nothing reads it to merge yet.
 */
export function tierRule(tier: Tier | null, last: readonly RuleMerge[]): TierRuleResult {
  if (tier !== null && NEVER_QUALIFY.includes(tier)) return "never";
  if (last.length < TIER_RULE_SAMPLE) return "too_few";
  const sample = last.slice(-TIER_RULE_SAMPLE);
  const ok = sample.filter(bad).length <= TIER_RULE_MAX_BAD && sample.every((m) => m.critical === 0);
  return ok ? "met" : "not_met";
}

export interface TierMergeRow {
  tier: Tier | null;
  /** Merges in the last 30 days. */
  merged: number;
  /** Of those, merges with a revert or a fix-forward. */
  reverted_or_fixed: number;
  /** Explicit owner verdicts (`/verdict`) other than accept on those merges. */
  not_accept: number;
  /** The tier's merges the rule read (at most 50, of any age). */
  sample: number;
  /** Of the sample, merges with a revert or a fix-forward. */
  sample_bad: number;
  /** Explicit critical verdicts on the sample. */
  sample_critical: number;
  rule: TierRuleResult;
  /** rule is `met`. */
  qualifies: boolean;
}

/** Pure: one row per tier 1–5 plus untiered from every merge (`all`) and the merges of the last 30 days (`recent`), both oldest first. */
export function aggregateTierMerges(all: readonly MergeEvaluation[], recent: readonly MergeEvaluation[]): TierMergeRow[] {
  return STATS_TIERS.map((tier) => {
    const window = recent.filter((m) => m.tier === tier);
    const sample = all.filter((m) => m.tier === tier).slice(-TIER_RULE_SAMPLE);
    const rule = tierRule(tier, sample);
    return {
      tier,
      merged: window.length,
      reverted_or_fixed: window.filter(bad).length,
      not_accept: sum(window.map((m) => m.explicit.changes + m.explicit.reject)),
      sample: sample.length,
      sample_bad: sample.filter(bad).length,
      sample_critical: sum(sample.map((m) => m.critical)),
      rule,
      qualifies: rule === "met",
    };
  });
}

/** The per-tier merge record from two read-only store reads; `factory stats` and `GET /api/v1/efficiency` both call it. */
export async function collectTierMerges(store: Pick<FactoryStore, "listMergeEvaluations">): Promise<TierMergeRow[]> {
  const all = await store.listMergeEvaluations(null);
  const recent = await store.listMergeEvaluations({ within_ms: MERGE_WINDOW_DAYS * DAY_MS });
  return aggregateTierMerges(all, recent);
}

/**
 * The owner figures of the last 30 days' merges: one merge evaluations read and one state changes read per merged
 * item. An item merged twice counts once, at its latest merge.
 */
export async function collectOwnerFigures(store: Pick<FactoryStore, "listMergeEvaluations" | "listStateChanges">): Promise<OwnerFigures> {
  const latest = new Map<WorkItemId, MergeEvaluation>();
  for (const e of await store.listMergeEvaluations({ within_ms: MERGE_WINDOW_DAYS * DAY_MS })) latest.set(e.work_item_id, e);
  const merged = [];
  for (const [id, e] of latest) merged.push({ changes: await store.listStateChanges(id), reverted_or_fixed: bad(e) });
  return ownerFigures(merged);
}

/** Autonomy from one read-only store read; `factory stats` and the dashboard route both call it. */
export async function collectAutonomy(store: Pick<FactoryStore, "listStatsRecords">): Promise<AutonomyReport> {
  return aggregateAutonomy(await store.listStatsRecords([]));
}

/** Reads through read-only store methods; the narrow type keeps every write method out of reach. */
export async function collectStats(
  store: Pick<FactoryStore, "listStatsRecords" | "listRunsByKind" | "listMergeEvaluations" | "listStateChanges">,
  config: StatsConfig,
): Promise<StatsReport> {
  const records = await store.listStatsRecords([STATS_REASONS.reject, STATS_REASONS.retry]);
  const sessions = await store.listRunsByKind("interactive", ["succeeded", "failed"]);
  const interactive = { runs: sessions.length, tokens: sum(sessions.map((r) => r.session_tokens ?? 0)) };
  const autonomy = await collectAutonomy(store);
  const merges = await collectTierMerges(store);
  const owner = await collectOwnerFigures(store);
  return { config, tiers: aggregateStats(records, config), adopted: aggregateAdopted(records, config), autonomy, merges, owner, interactive };
}

/** The one Autonomy line of `factory stats`. */
function formatAutonomy(a: AutonomyReport): string {
  if (a.autonomy === null) return "autonomy: not enough data (no merged factory items)";
  return `autonomy: ${a.autonomy.toFixed(2)} (${a.merged - a.with_push} of ${a.merged} merged factory items with no person's push)`;
}

/** The owner lines of `factory stats`, each labelled with its window; a figure with no data says so, never 0. */
function formatOwner(o: OwnerFigures): string[] {
  const window = `last ${MERGE_WINDOW_DAYS} days`;
  const value = (v: number | null, text: (n: number) => string) => (v === null ? "no data" : text(v));
  return [
    "",
    `human touches per merged item (${window}): ${value(o.touches_per_merged, (n) => `${n.toFixed(2)} (${o.asks} asks, ${o.merged} merged)`)}`,
    `median hours waiting on the owner (${window}): ${value(o.wait_hours_median, (n) => n.toFixed(1))}`,
    `revert/fix-forward rate (${window}): ${value(o.revert_rate, (n) => `${n.toFixed(2)} (${o.reverted_or_fixed} of ${o.merged} merged)`)}`,
    "asks: entries into a state waiting on the owner, recorded from 2026-11-22; the wait runs until the item's next state change.",
  ];
}

export function tierLabel(tier: Tier | null): string {
  return tier === null ? "untiered" : String(tier);
}

/** The rule column of the merge table. */
function ruleText(r: TierMergeRow): string {
  if (r.rule === "never") return "never";
  if (r.rule === "too_few") return `too few merges (${r.sample} of ${TIER_RULE_SAMPLE})`;
  return r.rule === "met" ? "met" : `not met (${r.sample_bad} reverted or fixed, ${r.sample_critical} critical)`;
}

/** Lines laid out in columns, two spaces apart. */
function columns(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

/** The merge table of `factory stats`: one row per tier, then what it counts. */
function formatTierMerges(rows: readonly TierMergeRow[]): string[] {
  const table = columns(
    ["tier", "merged_30d", "reverted_or_fixed", "not_accept", "rule"],
    rows.map((r) => [tierLabel(r.tier), String(r.merged), String(r.reverted_or_fixed), String(r.not_accept), ruleText(r)]),
  );
  return [
    "",
    ...table,
    "",
    `merged_30d: merges in the last ${MERGE_WINDOW_DAYS} days; reverted_or_fixed and not_accept (explicit /verdict other than accept) count those merges.`,
    `rule: met when a tier's last ${TIER_RULE_SAMPLE} merges have at most ${TIER_RULE_MAX_BAD} reverted or fixed forward and no critical /verdict; tiers 4 and 5 never. Nothing merges on it yet.`,
  ];
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
  const w = report.config.weights;
  return [
    ...columns(header, rows),
    ...(report.autonomy ? ["", formatAutonomy(report.autonomy)] : []),
    "",
    `items: CLOSED work items per tier. rate: feedback ÷ items, shown from min_sample ${report.config.min_sample} items.`,
    ...(report.adopted ? ["adopted: CLOSED changes a person opened and the factory adopted, any tier; not in the tier rows."] : []),
    "explicit: /verdict comments; implicit: verdicts read from merges, people's pushes and reverts. feedback weighs explicit verdicts only.",
    `weights: none ${w.none}, minor ${w.minor}, major ${w.major}, critical ${w.critical}.`,
    "/reject and /retry count applied commands only (spec_rejected, retry_requested); refused commands are not counted.",
    ...(report.interactive ? [`interactive sessions: ${report.interactive.runs} finished, ${report.interactive.tokens} tokens reported (factory session).`] : []),
    ...(report.merges ? formatTierMerges(report.merges) : []),
    ...(report.owner ? formatOwner(report.owner) : []),
  ].join("\n");
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
