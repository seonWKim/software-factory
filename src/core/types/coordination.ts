// Coordination, verdicts and token budgets (split from src/core/types.ts). No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

import type { Brand, RunId, StateChangeId, Timestamp, UserId, WorkItemId } from "./ids.js";
import type { RunKind } from "./runs.js";
import type { Tier } from "./work-item.js";

export type VerdictId = Brand<string, "VerdictId">;
/** `reverted` is implicit only: a person cannot write it with `/verdict`. */
export type VerdictKind = "accept" | "changes" | "reject" | "reverted";
export type VerdictSeverity = "none" | "minor" | "major" | "critical";
/** Where the `/verdict` comment was written: the item's issue or its PR. */
export type VerdictTarget = "issue" | "pr";

/**
 * A verdict on a work item (design §4): a human's `/verdict` (explicit), or one the factory reads from a PR event
 * (implicit: a merge, a person's push, a revert). Linked to the state_changes row (reason `human_verdict`, or
 * `implicit_verdict`) that carries the actor; changes no work-item field.
 */
export interface Verdict {
  id: VerdictId;
  work_item_id: WorkItemId;
  state_change_id: StateChangeId;
  verdict: VerdictKind;
  severity: VerdictSeverity;
  /** Null for `accept` without a reason, and for a Bad button tap (design §4). */
  reason: string | null;
  /**
   * The comment that held the command, or for an implicit verdict the key of the event it came from. Unique: a
   * redelivered comment or event records nothing.
   */
  comment_id: string;
  target: VerdictTarget;
  /** True when the factory recorded it from a PR event, false for a `/verdict` comment. */
  implicit: boolean;
  /** The PR head commit it is about; null when not known (older rows, a revert). One verdict per head is kept. */
  pr_head: string | null;
  at: Timestamp;
}

export type BudgetCheckpointId = Brand<string, "BudgetCheckpointId">;
/** `pending` until a human answers `/budget` (suggested), `/budget <tokens>` (custom) or `/reject`. */
export type BudgetAnswer = "pending" | "continued_suggested" | "continued_custom" | "rejected";
/** From the item's close_reason: completed → merged, rejected → rejected, failed → failed. */
export type BudgetOutcome = "merged" | "rejected" | "failed";

/**
 * A token-budget checkpoint (design §6): the item reached its budget when its next implement or review run
 * would start. That run is not queued; its kind, key and not_before are kept here and queued on `/budget`.
 */
export interface BudgetCheckpoint {
  id: BudgetCheckpointId;
  work_item_id: WorkItemId;
  tier: Tier;
  tokens_spent: number;
  /** The budget in force when the checkpoint was hit. */
  budget: number;
  suggested_budget: number;
  answer: BudgetAnswer;
  /** The budget a continue granted: the suggestion or the human's number. Null while pending or rejected. */
  granted_budget: number | null;
  held_run_kind: RunKind;
  held_run_key: string;
  held_run_not_before: Timestamp | null;
  /** Null until the item closes. */
  outcome: BudgetOutcome | null;
  created_at: Timestamp;
  answered_at: Timestamp | null;
}

export type UnreviewedMergeId = Brand<string, "UnreviewedMergeId">;

/** A change that merged with no work item (skipped, a fork, never adopted, merged before the first poll); one row per (project, change_ref). */
export interface UnreviewedMerge {
  id: UnreviewedMergeId;
  /** The project key (design 2026-11-01), as on WorkItem. */
  project: string;
  change_ref: string;
  merge_sha: string;
  /** The merger's user ID; null when the forge did not name one or it did not resolve to a user. */
  merger_id: UserId | null;
  at: Timestamp;
  /** The PR's title as the forge gave it at the merge; null for a row recorded before titles were kept (2026-11-24). */
  title: string | null;
}

/** How a dependency edge was found (design 2026-11-03). Each kind is the same edge to the scheduler. */
export type DependencyKind = "depends_on" | "sub_issue" | "blocked_by";
/**
 * What the controller last read of the item an edge points to. `merged`: its change is on the base branch (a
 * factory item closed by its PR's merge, or another issue closed as completed or a PR merged). `closed_unmerged`:
 * closed without that. Written by the controller outside the claim lock; the claim only reads it.
 */
export type DependencyState = "open" | "merged" | "closed_unmerged";

/** One edge: work item `work_item_id` waits for source item `depends_on` (e.g. "owner/repo#92") to merge. */
export interface DependencyEdge {
  work_item_id: WorkItemId;
  depends_on: string;
  kind: DependencyKind;
  state: DependencyState;
  /**
   * The source issue's `updated_at` when this edge was read from it (issue #254), or the store time of a read made
   * without one. Null on edges stored before it was kept.
   */
  source_updated_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** One shared path of a coordination cost, with its weight and why it weighs that much. */
export interface SharedPath {
  path: string;
  weight: number;
  /** Conflicts recorded on the path (the most among the files under it, for a folder). */
  conflicts: number;
  hotspot: boolean;
  /** A mechanical path (`mechanical_paths`): weighed `mechanical_weight` unless learned higher. Absent: not one. */
  mechanical?: boolean;
}

/**
 * The latest claim decision on a held implement run (design 2026-11-03): one row per run, rewritten when the
 * decision changes. `held`: the run stays queued; `deadlock`: claimed by the deadlock rule although held by
 * waiting items; `approved`: claimed past the hold after a human's `/approve`; `timed_out`: claimed after
 * `hold_policy` `run_after_minutes` ran out; `overlap_allowed`: claimed at once under `hold_policy` `run` (issue #314).
 */
export interface ClaimDecision {
  run_id: RunId;
  work_item_id: WorkItemId;
  decision: "held" | "deadlock" | "approved" | "timed_out" | "overlap_allowed";
  /** The holding item, or null for a PR with no work item. */
  holder_work_item_id: WorkItemId | null;
  /** How the holder is named: "#92" (its issue or PR number). */
  holder_ref: string;
  /** `running`, `pr` (an open PR) or `waiting` (another queued run). */
  holder_kind: "running" | "pr" | "waiting";
  shared: SharedPath[];
  cost: number;
  threshold: number;
  /** The holder's files are its allowed_paths: an open PR from before PR file lists were stored. */
  fallback: boolean;
  /** The user whose `/approve` lifted the hold; null until then. */
  approved_by: UserId | null;
  /** When the hold started; kept while the run stays held, whichever holder names it. Null on rows from before it. */
  held_since: Timestamp | null;
  at: Timestamp;
}
