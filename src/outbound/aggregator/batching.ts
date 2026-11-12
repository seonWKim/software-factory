// Outbound batching (RFC 0015 §15.1, owner decision 2026-11-08): when an open batch of a destination is flushed.
// Default `auto`: a batch is what one committed transaction requested for one destination, sent with no added
// delay. The heuristics add a debounce only when it helps. Each rule is a pure function of (destination stats,
// budget, batch, tick.now): no clock, no I/O, so tests drive them with tick times alone.

import { NOTIFY_REF } from "../../core/notifications.js";

/** `auto`: the heuristics below. `commit`: every commit is its own batch, sent at once. `fixed`: always `debounce`. */
export type BatchingMode = "auto" | "commit" | "fixed";

/** `outbound.batching.<destination kind>`: the policy of one kind of destination. */
export interface BatchingPolicy {
  readonly mode: BatchingMode;
  readonly debounce_ms: number;
  readonly max_wait_ms: number;
  readonly max_messages: number;
}

export const DEFAULT_BATCHING: BatchingPolicy = { mode: "auto", debounce_ms: 2_000, max_wait_ms: 30_000, max_messages: 10 };

/**
 * Owner notices for an adapter (design 12-notification-channels) wait in their own destination, `<type>:notify`
 * (NOTIFY_REF), so a channel's outage holds only its notices, and one 60 s window's go out as one batch.
 */
export function isNotifyDestination(destination: string): boolean {
  return destination === `${destination.split(":")[0]}:${NOTIFY_REF}`;
}

/** One notices tick (design 12-notification-channels): an adapter gets at most one notices message per window. */
export const NOTIFY_WINDOW_MS = 60_000;
/** An adapter's notices (`<type>:notify`): a fixed 60 s window with no cap, whatever outbound.batching says. */
export const NOTIFY_BATCHING: BatchingPolicy = { mode: "fixed", debounce_ms: NOTIFY_WINDOW_MS, max_wait_ms: NOTIFY_WINDOW_MS, max_messages: Number.MAX_SAFE_INTEGER };

/** What the aggregator knows about a destination when it decides. */
export interface DestinationStats {
  /** Batches sent to this destination in the last CHATTY_WINDOW_MS. */
  readonly recent_deliveries: number;
}

/** The request budget of the account the destination is written through (RFC 0006); null: none known. */
export interface Budget {
  readonly remaining: number;
  readonly limit: number;
}

/** The open batch the rule decides on. */
export interface BatchView {
  /** When its first intent arrived (ISO, a tick's or a message's time). */
  readonly opened_at: string;
  readonly intent_count: number;
  /** Its cause is a person's command: never delayed. */
  readonly reply: boolean;
}

export const CHATTY_WINDOW_MS = 60_000;
export const CHATTY_DELIVERIES = 3;
/** Under this share of its limit the budget is low. */
export const LOW_BUDGET = 0.2;

/** Never delay a reply to a person. */
export function replyNow(batch: BatchView): boolean {
  return batch.reply;
}

/** Flush at `max_messages`, whatever else holds the batch. */
export function capped(batch: BatchView, policy: BatchingPolicy): boolean {
  return batch.intent_count >= policy.max_messages;
}

/** A chatty destination (at least 3 deliveries in the last 60 s) waits `debounce` for more. */
export function chattyDebounceMs(stats: DestinationStats, policy: BatchingPolicy): number {
  return stats.recent_deliveries >= CHATTY_DELIVERIES ? policy.debounce_ms : 0;
}

/**
 * A low budget widens the window step by step up to `max_wait`, and shrinks it back as the budget recovers: under
 * 20% a quarter of max_wait, under 10% half, under 5% all of it.
 */
export function budgetWindowMs(budget: Budget | null, policy: BatchingPolicy): number {
  if (!budget || budget.limit <= 0) return 0;
  const share = budget.remaining / budget.limit;
  if (share >= LOW_BUDGET) return 0;
  if (share >= LOW_BUDGET / 2) return Math.round(policy.max_wait_ms / 4);
  if (share >= LOW_BUDGET / 4) return Math.round(policy.max_wait_ms / 2);
  return policy.max_wait_ms;
}

/**
 * When the batch is flushed, decided on each arrival and on the `outbound-flush` tick at `now`: at once for a
 * reply, a full batch or the `commit` mode; else `now` plus the wait the rules add, never past opened_at +
 * max_wait.
 */
export function flushAt(policy: BatchingPolicy, stats: DestinationStats, budget: Budget | null, batch: BatchView, now: string): string {
  if (policy.mode === "commit" || replyNow(batch) || capped(batch, policy)) return now;
  const wait = policy.mode === "fixed" ? policy.debounce_ms : Math.max(chattyDebounceMs(stats, policy), budgetWindowMs(budget, policy));
  if (wait === 0) return now;
  const latest = Date.parse(batch.opened_at) + policy.max_wait_ms;
  return new Date(Math.min(Date.parse(now) + wait, latest)).toISOString();
}

/** Whether a new commit for the destination joins its open batch rather than opening its own. */
export function joins(policy: BatchingPolicy, batch: BatchView & { readonly flush_at: string }, now: string): boolean {
  if (policy.mode === "commit" || capped(batch, policy)) return false;
  return Date.parse(batch.flush_at) > Date.parse(now);
}

const MODES: readonly BatchingMode[] = ["auto", "commit", "fixed"];
const POLICY_KEYS = ["mode", "debounce_ms", "max_wait_ms", "max_messages"] as const;

/**
 * `outbound.batching` in factory.config.json: for each destination kind (`github_issue`, `slack_thread`, ...), or
 * `*` for every kind not named, the fields that differ from DEFAULT_BATCHING. Absent: the default everywhere. A
 * wrong key or value fails startup, naming it.
 */
export function batchingPolicies(raw: unknown): Readonly<Record<string, BatchingPolicy>> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("outbound.batching must be an object of destination kinds");
  const out: Record<string, BatchingPolicy> = {};
  for (const [kind, v] of Object.entries(raw)) {
    const at = `outbound.batching.${kind}`;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(v)) if (!(POLICY_KEYS as readonly string[]).includes(k)) throw new Error(`${at}.${k} is not a batching field (${POLICY_KEYS.join(", ")})`);
    const p = { ...DEFAULT_BATCHING, ...(v as Partial<BatchingPolicy>) };
    if (!MODES.includes(p.mode)) throw new Error(`${at}.mode must be one of ${MODES.join(", ")}`);
    for (const k of ["debounce_ms", "max_wait_ms", "max_messages"] as const) {
      if (!Number.isInteger(p[k]) || p[k] < (k === "max_messages" ? 1 : 0)) throw new Error(`${at}.${k} must be a non-negative integer${k === "max_messages" ? " of at least 1" : ""}`);
    }
    out[kind] = p;
  }
  return out;
}

/** The policy of a destination (`<kind>:<ref>`): an adapter's notices take NOTIFY_BATCHING; else its kind's, `*`'s, the default. */
export function policyFor(policies: Readonly<Record<string, BatchingPolicy>>, destination: string): BatchingPolicy {
  if (isNotifyDestination(destination)) return NOTIFY_BATCHING;
  return policies[destination.split(":")[0]!] ?? policies["*"] ?? DEFAULT_BATCHING;
}
