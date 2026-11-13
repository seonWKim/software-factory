// Spend (design 06-spend): what the factory's agent runs cost, read from the outcomes the store already holds.
// Each run's cost is the harness's own figure (`outcomeCost`), never computed here; a run with none counts as
// unknown, apart, never as 0. Days and weeks are UTC: a day starts at 00:00 UTC, a week on Monday 00:00 UTC.
// Pure, apart from readSpend's one store read. No table of its own and no migration.

import { type Run, type RunKind, type Timestamp, type WorkItemId, outcomeCost, runTokenCount } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

export const DAY_MS = 24 * 3_600_000;
/** The run kinds whose agent reports a cost: the same kinds the status page's cost table counts. */
export const SPEND_KINDS: readonly RunKind[] = ["triage", "implement", "review", "resolve", "update"];
/** The longest range one read covers, in days. */
export const SPEND_MAX_DAYS = 366;

/** Totals over some runs: the known cost, every run's tokens, the runs, and the runs with no stored cost. */
export interface SpendTotals {
  cost_usd: number;
  tokens: number;
  runs: number;
  /** Runs with no stored cost: counted here, their cost never added as 0. */
  unknown: number;
}

export interface SpendDay extends SpendTotals { day: string }
export interface SpendItem extends SpendTotals { work_item_id: WorkItemId; kinds: RunKind[] }

export interface Spend {
  /** First and last UTC day, both inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  total: SpendTotals;
  /** Every UTC day of the range, oldest first, zero where nothing ran. */
  days: SpendDay[];
  /** Each item with a counted run, by cost (highest first), then by ID. */
  items: SpendItem[];
}

const zero = (): SpendTotals => ({ cost_usd: 0, tokens: 0, runs: 0, unknown: 0 });

function add(t: SpendTotals, r: Run): void {
  const cost = outcomeCost(r.outcome);
  t.runs++;
  t.tokens += runTokenCount(r);
  if (cost === null) t.unknown++;
  else t.cost_usd += cost;
}

/** Whether a finished run counts toward spend: one of SPEND_KINDS, with a finish time. */
const counted = (r: Run): boolean => r.finished_at !== null && SPEND_KINDS.includes(r.kind);

/** The UTC day of `ms` (YYYY-MM-DD). */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** 00:00 UTC of the day holding `ms`. */
export const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
/** Monday 00:00 UTC of the ISO week holding `ms`. */
export const weekStart = (ms: number): number => dayStart(ms) - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;

/** The totals of the counted runs in `runs`. */
export function spendTotals(runs: readonly Run[]): SpendTotals {
  const t = zero();
  for (const r of runs) if (counted(r)) add(t, r);
  return t;
}

/** Spend of `runs` over the UTC days `from` to `to` (both inclusive, YYYY-MM-DD), by day and by item. */
export function summarizeSpend(runs: readonly Run[], from: string, to: string): Spend {
  const days = new Map<string, SpendDay>();
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); ms <= Date.parse(`${to}T00:00:00.000Z`); ms += DAY_MS) {
    days.set(utcDay(ms), { day: utcDay(ms), ...zero() });
  }
  const items = new Map<WorkItemId, SpendItem>();
  const total = zero();
  for (const r of runs) {
    if (!counted(r)) continue;
    const day = days.get(r.finished_at!.slice(0, 10));
    if (!day) continue;
    add(total, r);
    add(day, r);
    const it = items.get(r.work_item_id) ?? { work_item_id: r.work_item_id, kinds: [], ...zero() };
    add(it, r);
    if (!it.kinds.includes(r.kind)) it.kinds.push(r.kind);
    items.set(r.work_item_id, it);
  }
  const byCost = [...items.values()].sort((a, b) => b.cost_usd - a.cost_usd || (a.work_item_id < b.work_item_id ? -1 : 1));
  return { from, to, total, days: [...days.values()], items: byCost };
}

/** Spend over the UTC days `from` to `to` (both inclusive), from the runs that finished in them: one store read. */
export async function readSpend(store: Pick<FactoryStore, "listRunsFinishedBetween">, from: string, to: string): Promise<Spend> {
  const start = `${from}T00:00:00.000Z` as Timestamp;
  const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS).toISOString() as Timestamp;
  return summarizeSpend(await store.listRunsFinishedBetween(start, end), from, to);
}

/** A budget setting's value: a positive dollar amount (12.50), or null for no budget. Throws the loader's message. */
export function usdBudget(key: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive dollar amount, such as 12.50, or null for no budget`);
  return value;
}
