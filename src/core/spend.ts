// Spend (design 06-spend): what the factory's agent runs cost, read from the outcomes the store already holds.
// Each run's cost is the harness's own figure (`outcomeCost`), never computed here; a run with none counts as
// unknown, apart, never as 0. Days and weeks are UTC: a day starts at 00:00 UTC, a week on Monday 00:00 UTC.
// Chat turns (design 04-chat-agent) are no runs: their spend is stored per turn (controller_chat_spend) and totalled
// apart, under `chat`, never added to the run totals. Coordinator cycles (design 06-spend) store one row each in the
// same table with kind `coordinator`: totalled apart, under `coordinator`, added to neither the runs nor `chat`.
// Pure, apart from readSpend's three store reads.

import { type Run, type RunKind, type Timestamp, type WorkItemId, outcomeCost, runTokenCount } from "./types.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";

export const DAY_MS = 24 * 3_600_000;
/** The run kinds whose agent reports a cost: the same kinds the status page's cost table counts, a routine's runs included. */
export const SPEND_KINDS: readonly RunKind[] = ["triage", "implement", "review", "resolve", "update", "routine"];
/** The most items a day names as its top items. */
export const SPEND_DAY_TOP = 3;
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

/** One of a day's most costly items: its known cost that day. */
export interface SpendDayItem { work_item_id: WorkItemId; cost_usd: number }
export interface SpendDay extends SpendTotals {
  day: string;
  /** The day's items with a known cost, most first (then by ID), at most SPEND_DAY_TOP; unknown-cost runs add nothing. */
  top: SpendDayItem[];
}
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
  /** The chat turns of the range, apart from the runs. */
  chat: ChatSpendTotals;
  /** The coordinator cycles of the range, apart from the runs and the chat turns; `turns` counts cycles. */
  coordinator: ChatSpendTotals;
}

/** One chat turn's stored spend (controller_chat_spend). */
export type ChatSpend = Parameters<FactoryStore["recordChatSpend"]>[0];

/** Totals over chat turns: the known cost, the tokens, the turns, and the turns with no known cost. */
export interface ChatSpendTotals { cost_usd: number; tokens: number; turns: number; unknown: number }

/** The totals of these chat turns; a turn with no known cost is counted apart, never as 0. */
export function chatSpendTotals(turns: readonly ChatSpend[]): ChatSpendTotals {
  const t: ChatSpendTotals = { cost_usd: 0, tokens: 0, turns: 0, unknown: 0 };
  for (const c of turns) {
    t.turns++;
    t.tokens += c.tokens;
    if (c.cost_usd === null) t.unknown++;
    else t.cost_usd += c.cost_usd;
  }
  return t;
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

/** By cost, highest first, then by ID. */
const byCostThenId = (a: { cost_usd: number; work_item_id: WorkItemId }, b: { cost_usd: number; work_item_id: WorkItemId }): number =>
  b.cost_usd - a.cost_usd || (a.work_item_id < b.work_item_id ? -1 : 1);

/** Spend of `runs`, chat `turns` and coordinator `cycles` over the UTC days `from` to `to` (both inclusive, YYYY-MM-DD), by day and by item. */
export function summarizeSpend(runs: readonly Run[], from: string, to: string, turns: readonly ChatSpend[], cycles: readonly ChatSpend[]): Spend {
  const days = new Map<string, SpendDay>();
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); ms <= Date.parse(`${to}T00:00:00.000Z`); ms += DAY_MS) {
    days.set(utcDay(ms), { day: utcDay(ms), ...zero(), top: [] });
  }
  // Each day's known cost per item; a run with no stored cost adds nothing here.
  const dayCost = new Map<string, Map<WorkItemId, number>>();
  const items = new Map<WorkItemId, SpendItem>();
  const total = zero();
  for (const r of runs) {
    if (!counted(r)) continue;
    const day = days.get(r.finished_at!.slice(0, 10));
    if (!day) continue;
    add(total, r);
    add(day, r);
    const cost = outcomeCost(r.outcome);
    if (cost !== null) {
      const perItem = dayCost.get(day.day) ?? new Map<WorkItemId, number>();
      perItem.set(r.work_item_id, (perItem.get(r.work_item_id) ?? 0) + cost);
      dayCost.set(day.day, perItem);
    }
    const it = items.get(r.work_item_id) ?? { work_item_id: r.work_item_id, kinds: [], ...zero() };
    add(it, r);
    if (!it.kinds.includes(r.kind)) it.kinds.push(r.kind);
    items.set(r.work_item_id, it);
  }
  for (const [day, perItem] of dayCost) {
    const top = [...perItem].map(([work_item_id, cost_usd]) => ({ work_item_id, cost_usd }));
    days.get(day)!.top = top.sort(byCostThenId).slice(0, SPEND_DAY_TOP);
  }
  const byCost = [...items.values()].sort(byCostThenId);
  return { from, to, total, days: [...days.values()], items: byCost, chat: chatSpendTotals(turns), coordinator: chatSpendTotals(cycles) };
}

/** Spend over the UTC days `from` to `to` (both inclusive): the runs that finished in them, the chat turns and the coordinator cycles, three store reads. */
export async function readSpend(store: Pick<FactoryStore, "listRunsFinishedBetween" | "listChatSpendBetween">, from: string, to: string): Promise<Spend> {
  const start = `${from}T00:00:00.000Z` as Timestamp;
  const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS).toISOString() as Timestamp;
  const runs = await store.listRunsFinishedBetween(start, end);
  return summarizeSpend(runs, from, to, await store.listChatSpendBetween(from, to, "chat"), await store.listChatSpendBetween(from, to, "coordinator"));
}

/** A dollar amount as the owner reads it ($5.00): the coordinator limit texts and the spend budget alert use it. */
export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The coordinator's daily limit setting (design 06-spend), which `approve <usd>` on its limit question sets. */
export const COORDINATOR_LIMIT_KEY = "spend.coordinator_daily_usd";
/** The coordinator limit question's pattern key: one per UTC day. */
export const coordinatorLimitKey = (day: string): string => `coordinator_limit:${day}`;
/** A dollar amount as `approve <usd>` takes it on the coordinator limit question (10, 12.50, $10). */
export const COORDINATOR_USD = /^\$?\d+(\.\d+)?$/;
/** The newest alerts read to find the coordinator limit question, as many as the alarm step reads. */
export const LIMIT_ALERTS_SCAN = 100;

/** What an answer to the coordinator limit question does: refused (why), or answered (the limit to set, null on reject). */
export type CoordinatorLimitAnswer = { alert: Alert; refused: string } | { alert: Alert; set_usd: number | null };

/**
 * A bare `approve <usd>` or `reject` on the coordinator limit question (design 06-spend), checked the same way by the
 * CLI before it stores the command and by the controller when it applies it. Only the question of the UTC day of
 * `now_ms` (key `coordinator_limit:<day>`), while it is not dismissed: an earlier day's question is over, since its
 * stop ended with its day. Null when there is none open: the caller keeps the command's other meanings (a held skill
 * version). `approve` needs a positive dollar amount, the new `spend.coordinator_daily_usd`; `reject` sets nothing.
 */
export function coordinatorLimitAnswer(alerts: readonly Alert[], now_ms: number, command: "approve" | "reject", value: string | null): CoordinatorLimitAnswer | null {
  const alert = alerts.find((a) => a.pattern_key === coordinatorLimitKey(utcDay(now_ms)));
  if (!alert || (alert.dismissed_at !== undefined && alert.dismissed_at >= alert.created_at)) return null;
  if (command === "reject") return { alert, set_usd: null };
  const amount = value !== null && COORDINATOR_USD.test(value) ? Number(value.replace(/^\$/, "")) : NaN;
  if (amount > 0) return { alert, set_usd: amount };
  return { alert, refused: `approve needs the new ${COORDINATOR_LIMIT_KEY} as a positive dollar amount, such as approve 10; ${value === null ? "none was given" : `${value} is not one`}` };
}

/** A budget setting's value: a positive dollar amount (12.50), or null for no budget. Throws the loader's message. */
export function usdBudget(key: string, value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive dollar amount, such as 12.50, or null for no budget`);
  return value;
}
