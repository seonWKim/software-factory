// Owner asks (design 06-efficiency, 07-improve-report): each entry into a `blocked_on: "human"` state is an ask. The
// controller kernel writes its reason code and tier into that state change's `detail`; the owner's action and the
// wait are read from the item's next state change. No table of its own: old rows (written before the detail) are not
// asks and are never backfilled. Pure, apart from readAskRows's store reads: no clock or model.

import { SPEC_DECISIONS, specChanged } from "./standing.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { BlockedOn, FailureGroup, ImproveWindow, StateChange, StateChangeDetail, Tier, Timestamp, WorkItemId } from "./types.js";

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

/** The improve report's rows (design 07-improve-report), kept with its patterns: never drafted, filed or alerted. */
export const OWNER_ASK = "owner_ask";
export const ASK_PROPOSAL = "ask_proposal";
/** One of the window's top ask reasons: `detail` is the reason code. */
export type AskRow = FailureGroup & { error_code: typeof OWNER_ASK; asks: number; answered: number; approved_unchanged: number };
/** A standing approval proposal: `detail` is the reason code, `text` what the report shows (proposalText). */
export type ProposalRow = FailureGroup & { error_code: typeof ASK_PROPOSAL; run_length: number; text: string };

/**
 * The report rows of `asks`: the top reasons of the asks made inside `window`, then a proposal for each reason whose
 * answers, up to the window's end, end in an unchanged run long enough. An answer after the window's end is not read.
 */
export function askRows(asks: readonly OwnerAsk[], window: ImproveWindow): FailureGroup[] {
  const end = Date.parse(window.window_end);
  const asOfEnd = asks
    .filter((a) => Date.parse(a.at) < end)
    .map((a) => (a.answered_at !== null && Date.parse(a.answered_at) > end ? { ...a, answered_at: null, action: null, wait_ms: null } : a));
  const inWindow = asOfEnd.filter((a) => Date.parse(a.at) >= Date.parse(window.window_start));
  const top = topAskReasons(inWindow).map((r): AskRow => ({
    error_code: OWNER_ASK, detail: r.reason, run_ids: [], work_item_ids: r.work_item_ids, asks: r.asks, answered: r.answered, approved_unchanged: r.approved_unchanged,
  }));
  const proposals = standingProposals(asOfEnd).map((p): ProposalRow => ({
    error_code: ASK_PROPOSAL, detail: p.reason, run_ids: [], work_item_ids: [], run_length: p.run_length, text: proposalText(p),
  }));
  return [...top, ...proposals];
}

/** How far back the improve report reads the project's asks for the proposal (design 07-improve-report). */
export const ASK_LOOKBACK_MS = 30 * 86_400_000;
/** The most items one read looks at for asks. */
const ASK_ITEMS_CAP = 10_000;

/**
 * The improve report's ask rows of `project` for `window`: one read of the items updated in the ASK_LOOKBACK_MS
 * before the window's end (an item that asked since was updated then), one state changes read per item of the project.
 */
export async function readAskRows(store: Pick<FactoryStore, "listWorkItemsWhere" | "listStateChanges">, project: string, window: ImproveWindow): Promise<FailureGroup[]> {
  const since = new Date(Date.parse(window.window_end) - ASK_LOOKBACK_MS).toISOString() as Timestamp;
  const changes: StateChange[] = [];
  for (const it of await store.listWorkItemsWhere({ updated_since: since, limit: ASK_ITEMS_CAP })) {
    if (it.project === project) changes.push(...(await store.listStateChanges(it.id)));
  }
  return askRows(ownerAsks(changes), window);
}

/** The proposal as the report shows it: text only, it creates no rule. */
export function proposalText(p: AskProposal): string {
  return `\`${p.reason}\` was approved unchanged ${p.run_length} times in a row. To stop asking, reply \`/standing\` to see the standing approvals you can turn on; nothing changes until you do.`;
}
