// Efficiency (design 06-efficiency): how many items the factory finishes and what each finished item takes, read
// from what the store already holds. Finished: a factory item CLOSED as completed with a stored merge evaluation,
// counted at its merged_at. Tokens are the same stored run usage as Spend (runTokenCount); a run with no stored usage
// is found from its outcome, never from runTokenCount's 0, and leaves its item out of the token figures, counted
// apart. Weeks are ISO weeks (Monday 00:00 UTC). Pure, apart from readEfficiency's store reads; no table of its own.

import type { MergeEvaluation } from "./merge-evaluation.js";
import { ownerAsks } from "./owner-asks.js";
import { DAY_MS, SPEND_KINDS, dayStart, utcDay, weekStart } from "./spend.js";
import { type Run, type StateChange, type Timestamp, type WorkItem, type WorkItemId, outcomeCost, runTokenCount } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;
/** Bars of each chart: hours of the last day, days of the last two weeks, ISO weeks (the current one included). */
export const EFFICIENCY_HOURS = 24;
export const EFFICIENCY_DAYS = 14;
export const EFFICIENCY_WEEKS = 8;
/** The most slowest and costliest items a week lists. */
export const EFFICIENCY_TOP = 5;
/** The most closed items one read looks at for the left-out count. */
export const EFFICIENCY_CLOSED_CAP = 10_000;

/** The store reads efficiency needs: all existing read methods. */
export type EfficiencyStore = Pick<FactoryStore, "listMergeEvaluations" | "getWorkItem" | "listRuns" | "listWorkItemsWhere" | "listStateChanges">;

/** A finished item: its merge time and every run it had; its state changes and whether its merge was reverted or fixed forward. */
export interface FinishedItem {
  item: WorkItem;
  merged_at: Timestamp;
  runs: readonly Run[];
  /** Absent: none read (no asks). */
  changes?: readonly StateChange[];
  /** Absent: false. */
  reverted_or_fixed?: boolean;
}

/** A merged item as the owner figures read it: its state changes and whether its merge was reverted or fixed forward. */
export interface MergedForOwner {
  changes: readonly StateChange[];
  reverted_or_fixed: boolean;
}

/**
 * What merged items took from the owner (design 06-efficiency). Null is no data, never 0: touches and the wait need
 * an ask on the merged items (asks are recorded from 2026-11-22, not backfilled), the rate needs a merge.
 */
export interface OwnerFigures {
  merged: number;
  /** Asks (entries into an owner state) on the merged items. */
  asks: number;
  /** asks ÷ merged. */
  touches_per_merged: number | null;
  /** The median wait of the answered asks, in hours. */
  wait_hours_median: number | null;
  /** Merges reverted or fixed forward ÷ merged. */
  revert_rate: number | null;
  reverted_or_fixed: number;
}

/** The owner figures of `merged` items. */
export function ownerFigures(merged: readonly MergedForOwner[]): OwnerFigures {
  const asks = ownerAsks(merged.flatMap((m) => m.changes));
  const waits = asks.flatMap((a) => (a.wait_ms === null ? [] : [a.wait_ms / HOUR_MS]));
  const bad = merged.filter((m) => m.reverted_or_fixed).length;
  return {
    merged: merged.length,
    asks: asks.length,
    touches_per_merged: asks.length === 0 ? null : asks.length / merged.length,
    wait_hours_median: median(waits),
    revert_rate: merged.length === 0 ? null : bad / merged.length,
    reverted_or_fixed: bad,
  };
}

/** One finished item's figures. Null: not known (a run without usage, or without a start or finish time). */
export interface ItemFigures {
  work_item_id: WorkItemId;
  title: string | null;
  merged_at: Timestamp;
  /** merged_at minus created_at. */
  total_ms: number;
  /** The sum of its runs' finished_at minus started_at. */
  agent_ms: number | null;
  /** total_ms minus agent_ms. */
  waiting_ms: number | null;
  tokens: number | null;
  /** The sum of the runs' known costs; null when no run has one. */
  cost_usd: number | null;
  /** Its runs with no stored usage. */
  runs_without_usage: number;
}

/** A weekly figure: median and 90th percentile (null: no data), their change from the week before, items not counted. */
export interface Figure {
  median: number | null;
  p90: number | null;
  median_change: number | null;
  p90_change: number | null;
  not_counted: number;
}

export interface Bar {
  /** Start of the hour, day or week (ISO time). */
  start: string;
  count: number;
}

export interface Chart {
  bars: Bar[];
  total: number;
}

export interface EfficiencyWeek {
  /** Monday of the ISO week (YYYY-MM-DD). */
  start: string;
  /** The week still running: its figures are so far. */
  current: boolean;
  finished: number;
  finished_change: number | null;
  tokens: Figure;
  total: Figure;
  agent: Figure;
  waiting: Figure;
  /** What the week's finished items took from the owner. */
  owner: OwnerFigures;
  /** By total time, longest first. */
  slowest: ItemFigures[];
  /** By known USD cost, highest first; items with no known cost are not listed. */
  costliest: ItemFigures[];
}

export interface Efficiency {
  hours: Chart;
  days: Chart;
  weeks: Chart;
  /** Oldest first, the current week last. */
  week_figures: EfficiencyWeek[];
  /** CLOSED factory items of the weeks shown that did not finish: cancelled (won't do, duplicate), rejected, failed. */
  left_out: { total: number; cancelled: number; rejected: number; failed: number };
  /** Runs of the weeks' finished items with no stored usage. */
  runs_without_usage: number;
}

/**
 * Whether a run has stored usage: from its outcome, never from runTokenCount's 0. Null outcome: none. Succeeded: a
 * `data.tokens` or `data.usage` figure. Failed: its `usage`.
 */
export function runHasUsage(r: Pick<Run, "outcome">): boolean {
  const o = r.outcome;
  if (!o) return false;
  if (o.status === "succeeded") return typeof o.data.tokens === "number" || (typeof o.data.usage === "object" && o.data.usage !== null);
  return o.usage !== undefined && o.usage !== null;
}

/** The middle value; the mean of the two middle values for an even count. Null for none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The nearest-rank 90th percentile: sorted[ceil(0.9 × n) − 1]. Null for none. */
export function p90(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1]!;
}

/** The change from `prev` to `cur` as a whole percent; null when either is missing or `prev` is 0. */
export function change(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** The runs that count: the agent kinds Spend counts, once claimed or finished (a run never claimed did nothing). */
const counted = (r: Run): boolean => SPEND_KINDS.includes(r.kind) && (r.started_at !== null || r.finished_at !== null || r.outcome !== null);

/** One finished item's figures from its runs (retries, reviews and resolves included). */
export function itemFigures(f: FinishedItem): ItemFigures {
  const runs = f.runs.filter(counted);
  const total_ms = Date.parse(f.merged_at) - Date.parse(f.item.created_at);
  const withoutUsage = runs.filter((r) => !runHasUsage(r)).length;
  const timed = runs.every((r) => r.started_at !== null && r.finished_at !== null);
  const agent_ms = timed ? runs.reduce((s, r) => s + (Date.parse(r.finished_at!) - Date.parse(r.started_at!)), 0) : null;
  const costs = runs.map((r) => outcomeCost(r.outcome)).filter((c): c is number => c !== null);
  return {
    work_item_id: f.item.id,
    title: f.item.title,
    merged_at: f.merged_at,
    total_ms,
    agent_ms,
    waiting_ms: agent_ms === null ? null : total_ms - agent_ms,
    tokens: withoutUsage > 0 ? null : runs.reduce((s, r) => s + runTokenCount(r), 0),
    cost_usd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0),
    runs_without_usage: withoutUsage,
  };
}

/** Median and 90th percentile of the known values; the unknown ones counted apart. Changes are set by the caller. */
function figure(values: readonly (number | null)[]): Figure {
  const known = values.filter((v): v is number => v !== null);
  return { median: median(known), p90: p90(known), median_change: null, p90_change: null, not_counted: values.length - known.length };
}

const withChange = (cur: Figure, prev: Figure): Figure => ({ ...cur, median_change: change(cur.median, prev.median), p90_change: change(cur.p90, prev.p90) });

const byId = (a: ItemFigures, b: ItemFigures): number => (a.work_item_id < b.work_item_id ? -1 : 1);

/** A chart of `n` bars of `size` ms ending with the one holding `last`, counting each time in `at`. */
function chart(at: readonly number[], last: number, size: number, n: number): Chart {
  const first = last - (n - 1) * size;
  const bars = Array.from({ length: n }, (_, i) => ({ start: new Date(first + i * size).toISOString(), count: 0 }));
  for (const t of at) {
    const i = Math.floor((t - first) / size);
    if (i >= 0 && i < n) bars[i]!.count++;
  }
  return { bars, total: bars.reduce((s, b) => s + b.count, 0) };
}

/** The figures of `finished` items and the `closed` ones left out, as of `now` (ms). */
export function summarizeEfficiency(finished: readonly FinishedItem[], closed: readonly WorkItem[], now: number): Efficiency {
  const thisWeek = weekStart(now);
  const mergedAt = finished.map((f) => Date.parse(f.merged_at)).filter((t) => t <= now);
  const merged = finished.filter((f) => Date.parse(f.merged_at) <= now);
  const figures = merged.map(itemFigures);

  // One week more than shown, so the oldest week shown has a change too.
  const weeks: EfficiencyWeek[] = [];
  for (let i = EFFICIENCY_WEEKS; i >= 0; i--) {
    const start = thisWeek - i * WEEK_MS;
    const inWeek = (f: { merged_at: Timestamp }) => Date.parse(f.merged_at) >= start && Date.parse(f.merged_at) < start + WEEK_MS;
    const items = figures.filter(inWeek);
    const timed = items.filter((f) => f.agent_ms !== null);
    const untimed = items.length - timed.length;
    const time = (pick: (f: ItemFigures) => number | null): Figure => ({ ...figure(timed.map(pick)), not_counted: untimed });
    const week: EfficiencyWeek = {
      start: utcDay(start),
      current: i === 0,
      finished: items.length,
      finished_change: null,
      tokens: figure(items.map((f) => f.tokens)),
      total: time((f) => f.total_ms),
      agent: time((f) => f.agent_ms),
      waiting: time((f) => f.waiting_ms),
      owner: ownerFigures(merged.filter(inWeek).map((f) => ({ changes: f.changes ?? [], reverted_or_fixed: f.reverted_or_fixed ?? false }))),
      slowest: [...items].sort((a, b) => b.total_ms - a.total_ms || byId(a, b)).slice(0, EFFICIENCY_TOP),
      costliest: items.filter((f) => f.cost_usd !== null).sort((a, b) => b.cost_usd! - a.cost_usd! || byId(a, b)).slice(0, EFFICIENCY_TOP),
    };
    const prev = weeks.at(-1);
    if (prev) {
      week.finished_change = change(week.finished, prev.finished);
      for (const k of ["tokens", "total", "agent", "waiting"] as const) week[k] = withChange(week[k], prev[k]);
    }
    weeks.push(week);
  }
  const shown = weeks.slice(1);
  const from = thisWeek - (EFFICIENCY_WEEKS - 1) * WEEK_MS;

  const left_out = { total: 0, cancelled: 0, rejected: 0, failed: 0 };
  for (const it of closed) {
    if (it.stage !== "CLOSED" || it.origin !== "factory" || Date.parse(it.updated_at) < from || Date.parse(it.updated_at) > now) continue;
    const r = it.close_reason;
    if (r === null || r === "completed") continue;
    left_out.total++;
    // Cancelled: won't do or duplicate.
    left_out[r === "rejected" || r === "failed" ? r : "cancelled"]++;
  }

  return {
    hours: chart(mergedAt, Math.floor(now / HOUR_MS) * HOUR_MS, HOUR_MS, EFFICIENCY_HOURS),
    days: chart(mergedAt, dayStart(now), DAY_MS, EFFICIENCY_DAYS),
    weeks: chart(mergedAt, thisWeek, WEEK_MS, EFFICIENCY_WEEKS),
    week_figures: shown,
    left_out,
    runs_without_usage: figures.filter((f) => Date.parse(f.merged_at) >= from).reduce((s, f) => s + f.runs_without_usage, 0),
  };
}

/**
 * Efficiency as of `now`: one read of the merge evaluations of the weeks (and the week before them), one item, one
 * runs and one state changes read per merged item, one read of the closed items. Adopted items (a person's PR) are left out.
 */
export async function readEfficiency(store: EfficiencyStore, now: Date): Promise<Efficiency> {
  const ms = now.getTime();
  const since = weekStart(ms) - EFFICIENCY_WEEKS * WEEK_MS;
  // An item merged twice counts once, at its latest merge.
  const latest = new Map<WorkItemId, MergeEvaluation>();
  for (const e of await store.listMergeEvaluations(new Date(since).toISOString() as Timestamp)) {
    const seen = latest.get(e.work_item_id);
    if (!seen || e.merged_at > seen.merged_at) latest.set(e.work_item_id, e);
  }
  const finished: FinishedItem[] = [];
  for (const [id, e] of latest) {
    const item = await store.getWorkItem(id);
    if (!item || item.stage !== "CLOSED" || item.close_reason !== "completed" || item.origin !== "factory") continue;
    finished.push({ item, merged_at: e.merged_at, runs: await store.listRuns(id), changes: await store.listStateChanges(id), reverted_or_fixed: e.reverted > 0 || e.fixed_forward > 0 });
  }
  const closed = await store.listWorkItemsWhere({
    stage: "CLOSED",
    updated_since: new Date(weekStart(ms) - (EFFICIENCY_WEEKS - 1) * WEEK_MS).toISOString() as Timestamp,
    limit: EFFICIENCY_CLOSED_CAP,
  });
  return summarizeEfficiency(finished, closed, ms);
}
