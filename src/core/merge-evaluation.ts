// Per-merge evaluation (design 06-measurement): one stored row per merge, written once by the merge's own
// transition, and what happened after it, read from the store only (state changes and verdicts). Pure.

import type { Tier, Timestamp, VerdictKind, WorkItemId } from "./types.js";
import { VERDICT_KINDS } from "./verdict.js";

/** One merge and what followed it. */
export interface MergeEvaluation {
  readonly work_item_id: WorkItemId;
  readonly project: string;
  readonly merge_sha: string;
  /** The item's tier at merge time. */
  readonly tier: Tier | null;
  /** The id of who made the merge transition (a user, an agent or `system:*`); never a display name. */
  readonly merged_by: string;
  readonly merged_at: Timestamp;
  /** The item's token_cost at merge time. */
  readonly token_cost: number;
  /** The item's title (free text: egress-scan it before showing it). */
  readonly title: string | null;
  /** Stored `reverted` state changes of the item. */
  readonly reverted: number;
  /** Stored `fixed_forward` state changes of the item. */
  readonly fixed_forward: number;
  /** Stored verdicts of the item (explicit and implicit) by kind. */
  readonly verdicts: Readonly<Record<VerdictKind, number>>;
}

/** Every verdict kind: the ones a person writes, and `reverted` (implicit only). */
export const ALL_VERDICT_KINDS: readonly VerdictKind[] = [...VERDICT_KINDS, "reverted"];

export function noVerdicts(): Record<VerdictKind, number> {
  return { accept: 0, changes: 0, reject: 0, reverted: 0 };
}

/** The digest of a set of merges: counts of merges, of reverted and fixed-forward ones, verdicts and tokens. */
export interface MergeDigest {
  readonly merged: number;
  /** Merges with at least one `reverted` state change. */
  readonly reverted: number;
  /** Merges with at least one `fixed_forward` state change. */
  readonly fixed_forward: number;
  readonly verdicts: Readonly<Record<VerdictKind, number>>;
  /** Sum of each merge's token_cost at merge time. */
  readonly tokens: number;
}

export function digestMerges(evaluations: readonly MergeEvaluation[]): MergeDigest {
  const verdicts = noVerdicts();
  for (const e of evaluations) for (const k of ALL_VERDICT_KINDS) verdicts[k] += e.verdicts[k];
  return {
    merged: evaluations.length,
    reverted: evaluations.filter((e) => e.reverted > 0).length,
    fixed_forward: evaluations.filter((e) => e.fixed_forward > 0).length,
    verdicts,
    tokens: evaluations.reduce((sum, e) => sum + e.token_cost, 0),
  };
}
