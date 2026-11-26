// The coordinator cycle (design 05-coordinator). At each controller tick, while the `coordinator` setting is on: when
// the stored due time has passed, the replica that holds the `coordinator` store lease (a sync lease row) and moves the
// due time on by one conditional update runs one cycle. The cycle asks the coordinator agent what to do with the items
// waiting for a merge, checks every answer in code, carries out a merge only through the existing local merge, and
// stores one record per action. The agent's answer never widens what the cycle may do: only local items of tier 1 or
// 2, and only up to `auto_merge_max_tier`, are merged. Before the agent call two gates (design 05-coordinator, 06-spend):
// with no item waiting for a merge, or with today's coordinator spend at `spend.coordinator_daily_usd`, the cycle
// stores one skipped record and calls nothing; at the limit it also raises the day's one owner question. A cycle that
// calls the agent stores one `coordinator` spend row and one Activity record with its cost.

import { coordinatorLimitAlert } from "../core/alarms.js";
import { COORDINATOR_LIMIT_KEY } from "../core/commands.js";
import { errorText, type Logger } from "../core/log.js";
import type { CoordinatorPorts } from "../core/controller-deps.js";
import type { StoreLease } from "../core/lease.js";
import { utcDay } from "../core/spend.js";
import type { WorkItem, WorkItemId } from "../core/types.js";
import { type ActionOutcome, type CoordinatorAction, type CoordinatorStore, type DaySpend } from "./store.js";

/** How often a cycle is due (owner answer 3). */
export const CYCLE_MS = 15 * 60_000;
/** The tiers the coordinator may merge (owner answer 2), whatever the agent answers. */
export const MERGE_TIERS: readonly number[] = [1, 2];
/** The store lease of the cycle: a row in the sync leases, so no new lease table. */
export const COORDINATOR_LEASE = "coordinator";
/** The one command the cycle carries out; `skip` records a decision to leave an item as it is. */
export const MERGE = "merge";
export const SKIP = "skip";
/** The command of a record about the whole cycle (its agent call failed, or a gate skipped it). */
export const CYCLE = "cycle";
/** The reason of a cycle skipped because no item waits for a merge. */
export const NOTHING_TO_DO = "nothing to do: no item is waiting for a merge";

/** One action as the agent proposes it. */
export interface ProposedAction {
  command: string;
  work_item_id: string | null;
  reason: string;
}

/** What one agent call answered: its status, its proposed actions and where its transcript is stored. */
export interface AgentCycle {
  status: string;
  actions: readonly ProposedAction[];
  transcript_link: string | null;
  /** The run's cost in USD from the runner's own report; null when it gave none or no model was called. */
  cost_usd: number | null;
  /** The run's input plus output tokens. */
  tokens: number;
  error?: string;
}

/** One call of the coordinator agent on the items waiting for a merge. */
export type CoordinatorAgent = (i: { cycle_id: string; items: readonly WorkItem[] }) => Promise<AgentCycle>;

/** What compose builds: the tables, the lease and the agent. */
export interface CoordinatorParts {
  store: CoordinatorStore;
  lease: StoreLease;
  agent: CoordinatorAgent;
  /** The injected Clock (compose passes the factory's); the cycle reads only its time. */
  clock: { now(): Date };
  log: Logger;
}

export type TickResult =
  | { kind: "off" }
  | { kind: "not_due"; due_at: string }
  | { kind: "busy"; holder: string | null }
  | { kind: "ran"; cycle_id: string; actions: readonly CoordinatorAction[] };

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Why the cycle refuses to merge `item`, or null when it may. In code, not in the prompt: the item must be local, of
 * tier 1 or 2, and that tier within `max_tier`.
 */
export function mergeRefusal(item: WorkItem | undefined, max_tier: number): string | null {
  if (!item) return "the item is not waiting for a merge";
  if (item.source.type !== "local") return `the coordinator merges only local items; this one is ${item.source.type}`;
  if (item.tier === null || !MERGE_TIERS.includes(item.tier)) return `the coordinator merges only tiers ${MERGE_TIERS.join(" and ")}; this item is tier ${item.tier ?? "unset"}`;
  if (item.tier > max_tier) return `auto_merge_max_tier is ${max_tier}; this item is tier ${item.tier}`;
  return null;
}

export class Coordinator {
  constructor(
    private readonly p: CoordinatorParts,
    private readonly ports: CoordinatorPorts,
  ) {}

  /** One controller tick: at most one cycle, and none while the switch is off, before the due time or on another replica. */
  async tick(): Promise<TickResult> {
    const settings = await this.ports.settings();
    if (!settings.on) return { kind: "off" };
    const seen = await this.p.store.dueAt();
    const now = this.p.clock.now().getTime();
    if (seen !== null && Date.parse(seen) > now) return { kind: "not_due", due_at: seen };
    const taken = await this.p.lease.acquire();
    if (!taken.ok) return { kind: "busy", holder: taken.holder };
    try {
      const cycle_id = `coordinator-${(seen ?? iso(now)).replace(/[-:]|\.\d+/g, "")}`;
      if (!(await this.p.store.claim(seen, iso(now + CYCLE_MS), cycle_id, iso(now)))) return { kind: "busy", holder: null };
      return { kind: "ran", cycle_id, actions: await this.cycle(cycle_id, settings) };
    } finally {
      await this.p.lease.release();
    }
  }

  private async cycle(cycle_id: string, settings: { max_tier: number; daily_usd: number }): Promise<CoordinatorAction[]> {
    const items = await this.ports.waiting();
    const out: CoordinatorAction[] = [];
    const record = async (a: Omit<CoordinatorAction, "cycle_id" | "seq" | "transcript_link">, transcript_link: string | null) => {
      const action = { ...a, cycle_id, seq: out.length + 1, transcript_link };
      await this.p.store.record(action, this.p.clock.now().toISOString());
      out.push(action);
    };
    const skipCycle = (reason: string) => record({ work_item_id: null, command: CYCLE, outcome: "skipped", reason }, null);
    // The gates: nothing waiting, or the UTC day's limit reached, calls no agent (the due time has moved already).
    if (items.length === 0) {
      await skipCycle(NOTHING_TO_DO);
      return out;
    }
    const day = utcDay(this.p.clock.now().getTime());
    const today = await this.p.store.spendOn(day);
    if (today.cost_usd >= settings.daily_usd) {
      // One question per UTC day: only the day's first stop asks, so an answered question is not asked again that day.
      const first = (await this.p.store.limitStopsOn(day, LIMIT_REACHED)) === 0;
      await skipCycle(limitReason(day, settings.daily_usd, today));
      if (first) await this.ports.limitReached(coordinatorLimitAlert({ day, limit_usd: settings.daily_usd, spent_usd: today.cost_usd, unknown: today.unknown }));
      this.p.log.warn("the coordinator reached its daily limit", { cycle_id, day, limit_usd: settings.daily_usd });
      return out;
    }
    let answer: AgentCycle;
    try {
      answer = await this.p.agent({ cycle_id, items });
    } catch (err) {
      answer = { status: "failed", actions: [], transcript_link: null, cost_usd: null, tokens: 0, error: errorText(err) };
    }
    await this.spent(cycle_id, day, answer, settings.daily_usd);
    if (answer.status !== "completed") {
      await record({ work_item_id: null, command: CYCLE, outcome: "failed", reason: `the coordinator agent ended ${answer.status}${answer.error ? `: ${answer.error}` : ""}` }, answer.transcript_link);
      this.p.log.info("coordinator cycle done", { cycle_id, actions: out.length });
      return out;
    }
    // The lease may have run out while the agent worked: a cycle that lost it carries out nothing more.
    const kept = await this.p.lease.renew();
    for (const a of answer.actions) {
      const item = items.find((it) => it.id === a.work_item_id);
      const id = (a.work_item_id ?? null) as WorkItemId | null;
      const outcome = async (o: ActionOutcome, why: string) => record({ work_item_id: id, command: a.command, outcome: o, reason: why }, answer.transcript_link);
      if (a.command === SKIP) await outcome("skipped", a.reason);
      else if (a.command !== MERGE) await outcome("refused", `the coordinator carries out only ${MERGE} and ${SKIP}; ${a.reason}`);
      else if (!kept.ok) await outcome("skipped", `the coordinator lease was lost during the cycle; ${a.reason}`);
      else {
        const refusal = mergeRefusal(item, settings.max_tier);
        if (refusal !== null) await outcome("refused", refusal);
        else {
          let r: string | null, failed = false;
          try {
            r = await this.ports.merge(item!.id, `${cycle_id}:${item!.id}`);
          } catch (err) {
            [r, failed] = [`the merge failed: ${errorText(err)}`, true];
          }
          await outcome(r === null ? "requested" : failed ? "failed" : "refused", r ?? a.reason);
        }
      }
    }
    this.p.log.info("coordinator cycle done", { cycle_id, actions: out.length });
    return out;
  }

  /** The cycle's one spend row (kind `coordinator`, keyed on the cycle) and its Activity record, whose reason gives the cost. */
  private async spent(cycle_id: string, day: string, answer: AgentCycle, limit_usd: number): Promise<void> {
    const now = this.p.clock.now().toISOString();
    if (!(await this.p.store.recordSpend({ cycle_id, day, cost_usd: answer.cost_usd, tokens: answer.tokens }, now))) return;
    const today = await this.p.store.spendOn(day);
    await this.p.store.recordActivity({ subject: cycle_id, outcome: answer.status, reason: costReason(answer.cost_usd, day, limit_usd, today) }, now);
  }
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const notCounted = (n: number): string => (n === 0 ? "" : `; ${n} cycle${n === 1 ? "" : "s"} with no reported cost not counted`);

/** A cycle's Activity reason: its cost (or that the runner reported none) and today's coordinator spend against the limit. */
export function costReason(cost_usd: number | null, day: string, limit_usd: number, today: DaySpend): string {
  const cost = cost_usd === null ? "the agent call reported no cost" : `the agent call cost ${usd(cost_usd)}`;
  return `${cost}; ${usd(today.cost_usd)} of the ${usd(limit_usd)} coordinator daily limit spent (UTC day ${day})${notCounted(today.unknown)}`;
}

/** How the skipped record's reason at the daily limit starts (limitStopsOn counts them). */
const LIMIT_REACHED = "the coordinator daily limit is reached";

/** The skipped record's reason at the daily limit: the limit, today's spend, and how cycles resume. */
export function limitReason(day: string, limit_usd: number, today: DaySpend): string {
  return `${LIMIT_REACHED}: ${usd(today.cost_usd)} spent of ${COORDINATOR_LIMIT_KEY} ${usd(limit_usd)} (UTC day ${day})${notCounted(today.unknown)}; `
    + "no agent call until the owner raises the limit (approve <usd>) or the UTC day ends";
}
