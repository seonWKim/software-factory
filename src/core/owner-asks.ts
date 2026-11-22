// Owner asks (design 06-efficiency, 07-improve-report): each entry into a `blocked_on: "human"` state is an ask. The
// controller kernel writes its reason code and tier into that state change's `detail`; the owner's action and the
// wait are read from the item's next state change. No table of its own: old rows (written before the detail) are not
// asks and are never backfilled. Pure: no store, clock or model.

import { SPEC_DECISIONS, specChanged } from "./standing.js";
import type { BlockedOn, StateChange, StateChangeDetail, Tier, Timestamp, WorkItemId } from "./types.js";

/** The detail keys an owner entry carries. */
export const ASK_REASON = "ask_reason";
export const ASK_TIER = "ask_tier";
/** The most ask reasons a report lists. */
export const ASK_TOP = 5;
/** Approvals in a row, unchanged, that propose a standing approval for a reason. */
export const ASK_PROPOSAL_RUN = 10;

/** What the owner did with an ask: read from the item's next state change. */
export type OwnerAction = "approved_unchanged" | "changed" | "rejected" | "other";

/** The reason code of a `blocked_reason`: the text before its first `:`, trimmed; `unknown` when there is none. */
export function reasonCode(blocked_reason: string | null | undefined): string {
  const code = (blocked_reason ?? "").split(":", 1)[0]!.trim();
  return code === "" ? "unknown" : code;
}

/** The detail an entry into an owner state adds (reason code and tier); null for a patch that does not block on the owner. */
export function askDetail(patch: { blocked_on?: BlockedOn; blocked_reason?: string | null }, tier: Tier | null): StateChangeDetail | null {
  if (patch.blocked_on !== "human") return null;
  return { [ASK_REASON]: reasonCode(patch.blocked_reason), [ASK_TIER]: tier };
}

/**
 * The owner's action in `next`, the state change after an ask: approved unchanged (spec approved, not changed),
 * changed (spec revised, or approved with changed paths), rejected (spec rejected), else other.
 */
export function ownerAction(next: Pick<StateChange, "reason" | "changes" | "detail">): OwnerAction {
  if (!Object.hasOwn(SPEC_DECISIONS, next.reason)) return "other";
  const outcome = SPEC_DECISIONS[next.reason]!;
  if (outcome === "rejected") return "rejected";
  const stored = next.detail?.spec_changed;
  const changed = typeof stored === "boolean" ? stored : specChanged(outcome, next.changes);
  return changed ? "changed" : "approved_unchanged";
}

/** One ask: its item, reason code, tier and time, and, once answered, the owner's action and the wait until it. */
export interface OwnerAsk {
  work_item_id: WorkItemId;
  reason: string;
  tier: Tier | null;
  at: Timestamp;
  /** The next state change's time; null while none follows. */
  answered_at: Timestamp | null;
  action: OwnerAction | null;
  wait_ms: number | null;
}

/** The asks in `changes` (any items, any order), each with its item's next state change as its answer; by time. */
export function ownerAsks(changes: readonly StateChange[]): OwnerAsk[] {
  const byItem = new Map<WorkItemId, StateChange[]>();
  for (const c of changes) byItem.set(c.work_item_id, [...(byItem.get(c.work_item_id) ?? []), c]);
  const out: OwnerAsk[] = [];
  for (const list of byItem.values()) {
    const sorted = [...list].sort((a, b) => a.version - b.version);
    for (const [i, c] of sorted.entries()) {
      const reason = c.detail?.[ASK_REASON];
      if (typeof reason !== "string") continue;
      const tier = c.detail?.[ASK_TIER];
      const next = sorted[i + 1];
      out.push({
        work_item_id: c.work_item_id,
        reason,
        tier: typeof tier === "number" ? (tier as Tier) : null,
        at: c.at,
        answered_at: next?.at ?? null,
        action: next ? ownerAction(next) : null,
        wait_ms: next ? Date.parse(next.at) - Date.parse(c.at) : null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.work_item_id < b.work_item_id ? -1 : 1));
}

/** One reason's asks: how many, how many were answered, and the share of those approved unchanged (null: none answered). */
export interface AskReason {
  reason: string;
  asks: number;
  answered: number;
  approved_unchanged: number;
  share_unchanged: number | null;
  work_item_ids: WorkItemId[];
}

/** The `n` most frequent reasons of `asks`, most asks first, then by reason code. */
export function topAskReasons(asks: readonly OwnerAsk[], n: number = ASK_TOP): AskReason[] {
  const by = new Map<string, OwnerAsk[]>();
  for (const a of asks) by.set(a.reason, [...(by.get(a.reason) ?? []), a]);
  const rows = [...by].map(([reason, list]): AskReason => {
    const answered = list.filter((a) => a.action !== null).length;
    const approved_unchanged = list.filter((a) => a.action === "approved_unchanged").length;
    return {
      reason, asks: list.length, answered, approved_unchanged,
      share_unchanged: answered === 0 ? null : approved_unchanged / answered,
      work_item_ids: [...new Set(list.map((a) => a.work_item_id))],
    };
  });
  return rows.sort((a, b) => b.asks - a.asks || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)).slice(0, n);
}

/** A reason whose latest answers were approved unchanged `run_length` times in a row: proposed as a standing approval. */
export interface AskProposal {
  reason: string;
  run_length: number;
}

/**
 * The reasons whose answered asks, by answer time, end in `threshold` or more approvals unchanged in a row. A changed
 * or rejected answer resets the run; an other answer neither counts nor resets. By reason code.
 */
export function standingProposals(asks: readonly OwnerAsk[], threshold: number = ASK_PROPOSAL_RUN): AskProposal[] {
  const runs = new Map<string, number>();
  const answered = asks.filter((a) => a.answered_at !== null).sort((a, b) => Date.parse(a.answered_at!) - Date.parse(b.answered_at!));
  for (const a of answered) {
    const run = runs.get(a.reason) ?? 0;
    if (a.action === "approved_unchanged") runs.set(a.reason, run + 1);
    else if (a.action === "changed" || a.action === "rejected") runs.set(a.reason, 0);
    else runs.set(a.reason, run);
  }
  return [...runs]
    .filter(([, n]) => n >= threshold)
    .map(([reason, run_length]) => ({ reason, run_length }))
    .sort((a, b) => (a.reason < b.reason ? -1 : 1));
}

/** The proposal as the report shows it: text only, it creates no rule. */
export function proposalText(p: AskProposal): string {
  return `\`${p.reason}\` was approved unchanged ${p.run_length} times in a row. To stop asking, reply \`/standing\` to see the standing approvals you can turn on; nothing changes until you do.`;
}
