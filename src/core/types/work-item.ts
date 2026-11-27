// Work items, their sources and their state changes (split from src/core/types.ts). No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

import type { DoneCheck } from "../done-checks.js";
import type { AgentId, RunId, StateChangeId, Timestamp, UserId, WorkItemId } from "./ids.js";

export type Stage = "NEW" | "READY" | "RUNNING" | "REVIEW" | "CLOSED";
/**
 * `dependency` (design 2026-11-03): the item's implement run waits for a linked item (`Depends on: #N`, a
 * sub-issue, a blocked-by link) to merge. Its status label is "implementing", never "needs human".
 * `outbound` (RFC 0015 M7): the item waits for outbound to deliver a write its next step needs (`pr_pending`: the
 * implement run's push and PR); it shows its stage, as `dependency` does. `human` with RECURRING_FAILURE: held (05-alarms).
 */
export type BlockedOn = "none" | "human" | "upstream" | "ci" | "budget" | "dependency" | "outbound";
export const RECURRING_FAILURE = "recurring_failure";
export type CloseReason = "completed" | "duplicate" | "wont_do" | "failed" | "rejected";
export type Tier = 1 | 2 | 3 | 4 | 5;

/** The source adapter's type, e.g. `local`: an item filed on this machine (issue #198). Core names no other source. */
export type SourceType = string;

/**
 * Where an item came from (design 2026-11-01). `factory`: intake of an issue or thread, the factory opens the
 * PR. `adopted`: a change a person opened, taken in at REVIEW; its source is that change.
 */
export type WorkItemOrigin = "factory" | "adopted";

export interface SourceRef {
  type: SourceType;
  /** Stable id within the source, e.g. "owner/repo#12". Unique with `type` (idempotent intake). */
  id: string;
  link: string;
}

export interface WorkItem {
  id: WorkItemId;
  /** Optimistic-concurrency version. Every successful transition increments it by 1. */
  version: number;
  source: SourceRef;
  /** The source's title (issue title), recorded at intake. Null on items created before it existed. */
  title: string | null;
  requester_id: UserId;
  /** The project key, `<provider>:<host>:<repo node id>` (design 2026-11-01). Never shown: show its label. */
  project: string;
  problem: string;
  resources: string[];
  done_criteria: string[] | null; // frozen after the human confirms the spec
  desired_output: string | null;
  scope: string | null;
  allowed_paths: string[];
  tier: Tier | null;
  stage: Stage;
  blocked_on: BlockedOn;
  blocked_reason: string | null;
  close_reason: CloseReason | null;
  loop_count: number;
  restart_count: number;
  token_cost: number;
  /**
   * The change columns (migration 35): `change_ref`, the PR number as text, is the field a patch sets (prNumber converts
   * it for a forge call). `change_url` is the PR link: the forge's open result, else derived from a forge key's stored
   * label. Null without a PR.
   */
  change_ref: string | null;
  change_url: string | null;
  merge_sha: string | null;
  fixes_pr: number | null;
  /** URL of the posted spec comment, set with READY + spec_pending. Null before it, and on older items. */
  spec_comment_url: string | null;
  /** URL of the last failure comment, set by the transition that blocks on a failed run. Null when that comment was withheld by the egress scan or never posted, and on older items. */
  failure_comment_url: string | null;
  /**
   * The issue text as received at intake (title and body). Triage overwrites `problem` with the spec; a
   * revision reads this instead. Null on items created before it existed.
   */
  issue_text: string | null;
  /** How many `/revise` commands started a new triage run. Not `loop_count`, which counts review loops. */
  revision_count: number;
  /** The text of the latest `/revise <feedback>` or `/reject <reason>` on the spec. Untrusted human text. */
  spec_feedback: string | null;
  /** `factory` on every item from before adoption existed. Set at intake, never changed. */
  origin: WorkItemOrigin;
  /**
   * The PR's head branch when it is not the factory branch (`adopted` items); null for factory items, whose
   * branch is `${branch_prefix}${id}`. Set at intake, never changed.
   */
  head_branch: string | null;
  /**
   * The PR head sha the factory last recorded: its own push (written by the run that pushed, under its lease),
   * the head at adoption, or a person's push already recorded as a `manual` run. Null until the first of these.
   */
  last_head_sha: string | null;
  /**
   * A phase of a split spec (design 2026-11-01): the split parent's id and this phase's place in merge order
   * (1-based). Both null on every other item. Set at intake, never changed.
   */
  parent_id: WorkItemId | null;
  phase: number | null;
  /**
   * The files the approved spec expects to change (triage's `files_to_change`), the coordination cost's input
   * for an item without a PR (design 2026-11-03). Null before triage, and on items from before it was stored.
   */
  files_to_change: string[] | null;
  done_checks: DoneCheck[] | null; // triage's check per done-when line, in order (design 04-triage, 2026-11-22); null before triage, and on items triaged before it was stored
  /**
   * The files the item's PR changes, as its last implement run pushed them (design 2026-11-03). Null with no
   * PR, and on PRs opened before it was stored: the coordination cost then falls back to `allowed_paths`.
   */
  pr_files: string[] | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Fields a transition may change. id, source, title, issue_text, requester, origin, head_branch,
 * last_head_sha, parent_id, phase, version and timestamps are store-owned. The PR field is `change_ref`.
 * `change_url` (the forge's open result) is written only with a new change_ref,
 * and never over a stored URL.
 */
export type WorkItemPatch = Partial<
  Omit<
    WorkItem,
    | "id" | "version" | "source" | "title" | "issue_text" | "requester_id" | "origin" | "head_branch" | "last_head_sha"
    | "parent_id" | "phase" | "created_at" | "updated_at"
  >
>;

export type Actor =
  | { kind: "user"; id: UserId }
  | { kind: "agent"; id: AgentId; run_id: RunId }
  | { kind: "system"; id: string }; // control-plane loop, e.g. "system:reaper"

/** One row per work-item change. IDs and field values only. */
export interface StateChange {
  id: StateChangeId;
  work_item_id: WorkItemId;
  /** Version the item had after this change. (work_item_id, version) is unique. */
  version: number;
  at: Timestamp;
  actor: Actor;
  /** Short machine-readable code, e.g. "intake", "spec_approved", "lease_expired". */
  reason: string;
  /** Only the fields that changed, with old and new values. */
  changes: { [K in keyof WorkItemPatch]?: { from: WorkItem[K]; to: WorkItem[K] } };
  /**
   * Facts that are not field diffs, IDs and shas only. E.g. `reverted`: { reverting_commit, reverting_pr };
   * `fixed_forward`: { fix_work_item_id }. Null on most rows, and on every row written before it existed.
   */
  detail: StateChangeDetail | null;
}

export type StateChangeDetail = Record<string, string | number | boolean | null>;
