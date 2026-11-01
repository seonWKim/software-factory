// Domain types shared by every layer. No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkItemId = Brand<string, "WorkItemId">;
export type RunId = Brand<string, "RunId">;
export type StateChangeId = Brand<string, "StateChangeId">;
export type HandoffId = Brand<string, "HandoffId">;
export type UserId = Brand<string, "UserId">;
export type AgentId = Brand<string, "AgentId">; // one per role identity, e.g. "agent:triage"
export type WorkerId = Brand<string, "WorkerId">;

/** ISO-8601 UTC timestamp. */
export type Timestamp = Brand<string, "Timestamp">;

export type Stage = "NEW" | "READY" | "RUNNING" | "REVIEW" | "CLOSED";
export type BlockedOn = "none" | "human" | "upstream" | "ci" | "budget";
export type CloseReason = "completed" | "duplicate" | "wont_do" | "failed" | "rejected";
export type Tier = 1 | 2 | 3 | 4 | 5;

export type SourceType = "github_issue" | "slack_thread";

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
  pr_number: number | null;
  merge_sha: string | null;
  fixes_pr: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Fields a transition may change. id, source, title, requester, version and timestamps are store-owned. */
export type WorkItemPatch = Partial<
  Omit<WorkItem, "id" | "version" | "source" | "title" | "requester_id" | "created_at" | "updated_at">
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

/** `update` runs no agent: the worker merges the base branch into a factory PR branch (design §5). */
export type RunKind = "triage" | "implement" | "review" | "update";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Lease {
  owner: WorkerId;
  /** Fencing token. Strictly increases on every claim of the same run; stale holders are rejected by it. */
  token: number;
  expires_at: Timestamp;
}

/** A unit of agent work. The controller enqueues runs, workers claim them. */
export interface Run {
  id: RunId;
  work_item_id: WorkItemId;
  kind: RunKind;
  /** Unique. E.g. `${work_item_id}:implement:${loop_count}`, so a re-enqueue is a no-op. */
  idempotency_key: string;
  status: RunStatus;
  attempt: number;
  lease: Lease | null;
  /** Set when the worker finishes. Structured, already egress-scanned (G5). */
  outcome: RunOutcome | null;
  /** Set when the controller has applied the outcome to the work item. */
  acknowledged_at: Timestamp | null;
  /** When the latest claim started this run (set on every claim). Null until claimed, and on rows from before it existed. */
  started_at: Timestamp | null;
  /** When the run reached succeeded or failed (worker completion or reaper). Null until then, and on older rows. */
  finished_at: Timestamp | null;
  /**
   * Earliest time any worker may claim this run (retry backoff, rate-limit reset). Null: at once. Stored on
   * the run so every worker and replica waits, not only the one that saw the failure (design §5 Restarts).
   */
  not_before: Timestamp | null;
  created_at: Timestamp;
  /** Rewritten by every heartbeat; on a running run it is the time of the last heartbeat (or the claim). */
  updated_at: Timestamp;
}

export type RunOutcome =
  | { status: "succeeded"; summary: string; data: Record<string, unknown> }
  | {
      status: "failed";
      /** `rate_limited` means a usage or rate limit, not a failed attempt (design §5 Restarts). */
      error_code: string;
      detail: string;
      /** Infrastructure failure (lease loss, timeout, exception): counts toward `max_restart`, not `max_attempts`. */
      infra: boolean;
      /** For `rate_limited`: when the limit resets, if the runner could tell. */
      reset_at?: Timestamp | null;
      /** The last part of the run's output, for the last-attempt comment. Egress-scanned with the outcome. */
      output_tail?: string;
    };

/** One row per implementer commit (design §4). Truth for resuming on any node. */
export interface Handoff {
  id: HandoffId;
  run_id: RunId;
  work_item_id: WorkItemId;
  commit_sha: string;
  worked_on: string;
  next_steps: string;
  at: Timestamp;
}
