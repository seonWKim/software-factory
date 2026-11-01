import type { TierHistory } from "../core/budget.js";
import type {
  Actor,
  BlockedOn,
  BudgetAnswer,
  BudgetCheckpoint,
  BudgetCheckpointId,
  Tier,
  Handoff,
  Run,
  RunId,
  RunInput,
  RunKind,
  RunOutcome,
  RunStatus,
  SourceRef,
  SourceType,
  StateChange,
  StateChangeDetail,
  Stage,
  Timestamp,
  UnreviewedMerge,
  UserId,
  Verdict,
  VerdictKind,
  VerdictSeverity,
  VerdictTarget,
  WorkItem,
  WorkItemId,
  WorkItemPatch,
  WorkerId,
} from "../core/types.js";
import type { SourceEvent } from "./source-adapter.js";
import type { StatsRecord } from "../core/stats.js";

// Contract for every implementation (SQLite now, Postgres later):
// - Each method is one transaction. A method either fully applies or changes nothing.
// - Time comes from the Clock injected into the implementation (SystemClock in prod, FakeClock in tests).
//   Method arguments never carry "now".
// - Losing a race is a normal result, not an exception. Exceptions mean the store itself failed.

export interface NewWorkItem {
  source: SourceRef;
  /** The source's title, kept apart from `problem` (triage overwrites `problem` with the spec). */
  title?: string | null;
  requester_id: UserId;
  project: string;
  problem: string;
  resources: string[];
  /**
   * Adoption of a pull request a person opened (design 2026-11-01). Present: the item starts at REVIEW with
   * origin `adopted`, these fields set, done_criteria null, and the state change reason `pr_adopted`.
   */
  adopted?: AdoptedPr;
}

export interface AdoptedPr {
  pr_number: number;
  head_branch: string;
  /** The PR's head at adoption: recorded as last_head_sha, so only later pushes count as a person's. */
  head_sha: string;
  /** The files the PR changes, so the scope rules and floor tiers apply to them. */
  allowed_paths: string[];
  /** The floor tier of those files, or null when none applies. */
  tier: Tier | null;
}

/**
 * The head of an open PR as a poll saw it, against the item's last recorded head (design 2026-11-01).
 * Applies only while the item's last_head_sha still equals `expected_head`.
 */
export interface RecordPrHeadInput {
  id: WorkItemId;
  expected_head: string | null;
  head_sha: string;
  /**
   * A person's push: writes one run of kind `manual`, status succeeded and already acknowledged, with this
   * actor and the range expected_head..head_sha in its outcome. Null: only records the head (a baseline for
   * an item that had none). Ignored when `expected_head` is null, as there is no range to name.
   */
  manual: { actor: Actor; pr_number: number } | null;
}

export type RecordPrHeadResult =
  /** `run`: the manual run written, or null for a baseline. */
  | { ok: true; item: WorkItem; run: Run | null }
  | { ok: false; reason: "not_found" }
  /** last_head_sha is no longer `expected_head` (another poll or a factory push recorded first). Nothing written. */
  | { ok: false; reason: "head_moved"; current: WorkItem };

export interface NewUnreviewedMerge {
  project: string;
  pr_number: number;
  merge_sha: string;
  merger_id: UserId | null;
}

export interface NewRun {
  work_item_id: WorkItemId;
  kind: RunKind;
  idempotency_key: string;
  /** Earliest claim time (retry backoff). Absent or null: claimable at once. */
  not_before?: Timestamp | null;
  /** Stored with the run for the worker to read (e.g. `/resolve` notes). Absent or null: none. */
  input?: RunInput | null;
}

export interface TransitionInput {
  id: WorkItemId;
  /** Applies only if the item's current version equals this. */
  expected_version: number;
  patch: WorkItemPatch;
  actor: Actor;
  reason: string;
  /** Stored on the state_changes row as `detail`. */
  detail?: StateChangeDetail;
  /** Mark this finished run as acknowledged in the same transaction (controller consuming an outcome). */
  ack_run?: RunId;
  /** Enqueue a run in the same transaction. No-op if its idempotency_key already exists. */
  enqueue?: Omit<NewRun, "work_item_id">;
  /**
   * Cancel every `queued` run of this item in the same transaction (waiting on `not_before` or not), so no
   * worker can claim one afterwards. Running runs are left alone. Cancelled runs are unacknowledged, with no
   * outcome and no `finished_at`, and go through the controller's ack path like any finished run.
   */
  cancel_queued_runs?: boolean;
}

export type TransitionResult =
  /** `cancelled`: the runs `cancel_queued_runs` cancelled (empty without it). */
  | { ok: true; item: WorkItem; state_change: StateChange; enqueued: Run | null; cancelled: RunId[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: WorkItem }
  /** ack_run was given but that run is not finished, belongs to another item, or is already acknowledged. */
  | { ok: false; reason: "run_not_ackable" };

export interface RecordVerdictInput {
  id: WorkItemId;
  /** Applies only if the item's current version equals this. */
  expected_version: number;
  /** The human who wrote the verdict. */
  actor: Extract<Actor, { kind: "user" }>;
  verdict: VerdictKind;
  severity: VerdictSeverity;
  reason: string | null;
  comment_id: string;
  target: VerdictTarget;
}

export type RecordVerdictResult =
  | { ok: true; item: WorkItem; state_change: StateChange; verdict: Verdict }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: WorkItem }
  /** A verdict from this comment is already stored (checked before the version). Nothing changed. */
  | { ok: false; reason: "duplicate"; verdict: Verdict };

/** What a budget checkpoint records when it opens (design §6). The held run is kept here, not queued. */
export interface NewBudgetCheckpoint {
  tier: Tier;
  tokens_spent: number;
  budget: number;
  suggested_budget: number;
  held_run_kind: RunKind;
  held_run_key: string;
  held_run_not_before: Timestamp | null;
}

/** A transition (the block) plus the checkpoint row, in one transaction. It never enqueues a run. */
export interface OpenBudgetCheckpointInput extends Omit<TransitionInput, "enqueue"> {
  checkpoint: NewBudgetCheckpoint;
}

/** A transition (continue or close) plus the answer on a pending checkpoint, in one transaction. */
export interface AnswerBudgetCheckpointInput extends TransitionInput {
  checkpoint_id: BudgetCheckpointId;
  answer: Exclude<BudgetAnswer, "pending">;
  /** The budget a continue grants; null for a rejection. */
  granted_budget: number | null;
}

export type BudgetCheckpointResult =
  | { ok: true; item: WorkItem; state_change: StateChange; enqueued: Run | null; checkpoint: BudgetCheckpoint }
  | Exclude<TransitionResult, { ok: true }>
  /** openBudgetCheckpoint: the item already has a pending checkpoint. Nothing changed. */
  | { ok: false; reason: "checkpoint_pending" }
  /** answerBudgetCheckpoint: no such checkpoint on this item, or it was already answered. Nothing changed. */
  | { ok: false; reason: "checkpoint_not_pending" };

/** Read-only filter for listWorkItemsWhere. Absent fields do not filter. */
export interface WorkItemFilter {
  stage?: Stage | undefined;
  blocked_on?: BlockedOn | undefined;
  /** Leave out CLOSED items. Ignored when `stage` is given. */
  exclude_closed?: boolean | undefined;
  limit: number;
}

export interface ClaimInput {
  worker_id: WorkerId;
  kinds: readonly RunKind[];
  lease_ms: number;
}

export type LeaseResult = { ok: true; run: Run } | { ok: false; reason: "lease_lost" };

/** `applied`: the highest migration recorded in the database (0 when none). `latest`: the highest this code has. */
export interface SchemaVersion {
  applied: number;
  latest: number;
}

export interface FactoryStore {
  migrate(): Promise<void>;
  /**
   * Read-only probe for health checks: reaches the database and reads the applied schema version. Writes
   * nothing: no migration, no table creation, no lock. Throws when the database cannot be reached.
   */
  schemaVersion(): Promise<SchemaVersion>;
  close(): Promise<void>;

  // Work items

  /**
   * Idempotent on (source.type, source.id). Writes the "intake" state change and enqueues `enqueue`
   * in the same transaction, only when created.
   */
  createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id"> },
  ): Promise<{ item: WorkItem; created: boolean }>;
  getWorkItem(id: WorkItemId): Promise<WorkItem | null>;
  getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null>;
  /** The item in `project` whose PR (factory or adopted) has this number (oldest if several). */
  getWorkItemByPr(project: string, pr_number: number): Promise<WorkItem | null>;
  /** The item in `project` whose PR merged as this commit (oldest if several). */
  getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null>;
  /** Newest first. */
  listWorkItems(limit: number): Promise<WorkItem[]>;
  /** Items matching `filter`, most recently updated first. Read-only. */
  listWorkItemsWhere(filter: WorkItemFilter): Promise<WorkItem[]>;
  /** Number of items matching `filter`, with no limit. Read-only. */
  countWorkItemsWhere(filter: Omit<WorkItemFilter, "limit">): Promise<number>;
  /** Number of work items in each stage. Every stage is present, 0 when it has none. Read-only. */
  countWorkItemsByStage(): Promise<Record<Stage, number>>;
  /**
   * The only way to change a work item: conditional update + state_changes row (+ optional ack/enqueue).
   * A transition that closes the item also sets `outcome` on its checkpoints that have none (completed →
   * merged, rejected → rejected, failed → failed), in the same transaction.
   */
  transition(input: TransitionInput): Promise<TransitionResult>;
  listStateChanges(id: WorkItemId): Promise<StateChange[]>;
  /**
   * Stores a human verdict: bumps the version and writes a state_changes row (reason `human_verdict`, the
   * user as actor, `changes` = {}) and a linked verdicts row, in one transaction. No other field changes.
   * Idempotent on `comment_id`.
   */
  recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult>;
  /** The item's verdicts, oldest first. Read-only. */
  listVerdicts(id: WorkItemId): Promise<Verdict[]>;
  /**
   * Every work item (any stage, no cap), oldest first, with the reasons of its state changes that are in
   * `reasons` (in version order) and the severities of its verdicts (oldest first). For `factory stats`.
   * Read-only.
   */
  listStatsRecords(reasons: readonly string[]): Promise<StatsRecord[]>;

  // Budget checkpoints (design §6)

  /**
   * The transition (as `transition`, no enqueue) and a new `pending` checkpoint row, in one transaction.
   * Refused with `checkpoint_pending` while the item has a pending checkpoint.
   */
  openBudgetCheckpoint(input: OpenBudgetCheckpointInput): Promise<BudgetCheckpointResult>;
  /**
   * The transition (as `transition`, with its optional enqueue) and the answer on checkpoint
   * `checkpoint_id`, in one transaction. Only a pending checkpoint of this item is answered, once.
   */
  answerBudgetCheckpoint(input: AnswerBudgetCheckpointInput): Promise<BudgetCheckpointResult>;
  /** The item's checkpoints, oldest first. Read-only. */
  listBudgetCheckpoints(id: WorkItemId): Promise<BudgetCheckpoint[]>;
  /** CLOSED items of `project` in `tier`, and the token_cost of those that closed `completed`. Read-only. */
  getTierHistory(project: string, tier: Tier): Promise<TierHistory>;

  // Runs

  /**
   * Pull-based claim: among queued runs of the given kinds whose `not_before` has passed, the first by kind
   * rank (review, triage, update, implement, resolve), then created_at, then insertion order → running,
   * attempt + 1, new lease with token + 1. An implement-type run whose item already has one running is
   * skipped, never blocking the runs after it. Returns null while a claim pause (pauseClaims) is in effect.
   */
  claimRun(input: ClaimInput): Promise<Run | null>;
  /**
   * Stops every claim, for every work item and worker, until `resume_at` (a usage or rate limit). Only ever
   * moves the pause later. `extended` is true when this call moved it, so exactly one caller logs it.
   */
  pauseClaims(resume_at: Timestamp): Promise<{ extended: boolean; resume_at: Timestamp }>;
  /** The current claim pause's end, or null if there is none or it has passed. Read-only. */
  getClaimPause(): Promise<Timestamp | null>;
  /**
   * Extends the lease while the run is `running` with this `token`, whatever the clock says: a lease that
   * expired but was not reaped or reclaimed (host sleep) is renewed. lease_lost means stop work immediately.
   */
  heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult>;
  /** Records the outcome and clears the lease while the run is `running` with this `token`, even past `expires_at`. */
  completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult>;
  /** Finished runs the controller has not applied yet, oldest first. */
  listUnacknowledgedRuns(limit: number): Promise<Run[]>;
  /**
   * Reaper: running runs whose lease expired → queued again, or failed once `attempt` (counted per claim)
   * reached max_attempts. A requeued run gets `not_before` = now + `backoff_ms(attempt)` (absent: at once).
   * A run whose item is CLOSED is cancelled instead of requeued, so a closed item never runs again.
   */
  expireLeases(max_attempts: number, backoff_ms?: (attempt: number) => number): Promise<RunId[]>;
  getRun(id: RunId): Promise<Run | null>;
  listRuns(id: WorkItemId): Promise<Run[]>;
  /** Runs (any item) in one of `statuses`, oldest first by created_at. Read-only. */
  listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]>;
  /**
   * Runs whose finished_at lies within the last `window_ms` of the store's clock, newest first. Runs that
   * finished before finished_at existed (null) are never included. Read-only.
   */
  listRunsFinishedWithin(window_ms: number): Promise<Run[]>;

  // PR heads (design 2026-11-01)

  /**
   * The head sha a run just pushed to its item's PR branch, recorded as the item's last_head_sha. Accepted only
   * while the run is `running` with this `token` (as appendHandoff). Bumps no version: the field is store-owned.
   */
  recordPushedHead(runId: RunId, token: number, head_sha: string): Promise<{ ok: true } | { ok: false; reason: "lease_lost" }>;
  /**
   * Sets last_head_sha to `head_sha` if it still equals `expected_head`, and with `manual` writes the `manual`
   * run, in one transaction. Changes no stage, blocked field or version. Idempotent: a repeat finds the head
   * already moved and writes nothing.
   */
  recordPrHead(input: RecordPrHeadInput): Promise<RecordPrHeadResult>;

  // Unreviewed merges (design 2026-11-01)

  /** Idempotent on (project, pr_number): a second call returns the first row with created false. */
  recordUnreviewedMerge(input: NewUnreviewedMerge): Promise<{ merge: UnreviewedMerge; created: boolean }>;
  /** Newest first. Read-only. */
  listUnreviewedMerges(limit: number): Promise<UnreviewedMerge[]>;

  // Handoffs

  /**
   * Accepted only while the run is `running` with this `token` (the clock does not decide; see heartbeat).
   * Idempotent on (run_id, commit_sha).
   */
  appendHandoff(
    input: Omit<Handoff, "id" | "at">,
    token: number,
  ): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }>;
  listHandoffs(id: WorkItemId): Promise<Handoff[]>;

  // Poll cursors (intake, post-merge watcher). Intake is idempotent, so a cursor going backwards only re-reads.

  getCursor(name: string): Promise<string | null>;
  /** Sets the cursor only if it still equals `expected`. */
  advanceCursor(name: string, expected: string | null, next: string): Promise<boolean>;

  // Stream intake (docs/architecture.md, Intake): the inbox of pushed events and the listener lease.

  /**
   * Stores one pushed event, in the same transaction as a check that `lease_token` is still the token of
   * `source_type`'s listener lease (fenced by the token, not the clock, as run leases are). A dedupe_key
   * already stored for this source type is a no-op that reports the existing row. Sequence numbers only
   * grow, and appends for one source type commit in sequence order (they serialize on the lease row).
   */
  appendInbox(input: NewInboxEvent): Promise<AppendInboxResult>;
  /** Rows of `source_type` with seq > `after_seq`, in seq order, at most `limit`. Read-only. */
  listInboxAfter(source_type: SourceType, after_seq: number, limit: number): Promise<InboxRow[]>;
  /**
   * Deletes rows of `source_type` that are both at or below `through_seq` and received more than
   * `older_than_ms` ago (store clock). Returns how many went.
   */
  pruneInbox(source_type: SourceType, through_seq: number, older_than_ms: number): Promise<number>;
  /**
   * Takes `source_type`'s listener lease for `owner` if nobody holds it or the holder's lease expired;
   * the token goes up by one on every take. Otherwise reports the current holder.
   */
  acquireListenerLease(source_type: SourceType, owner: string, lease_ms: number): Promise<ListenerLeaseResult>;
  /** Extends the lease while `token` is still current, whatever the clock says (like heartbeat). */
  renewListenerLease(source_type: SourceType, token: number, lease_ms: number): Promise<ListenerLeaseResult>;
  /** Ends the lease now if `token` is still current, so another replica can take it at once. */
  releaseListenerLease(source_type: SourceType, token: number): Promise<void>;
}

export interface NewInboxEvent {
  source_type: SourceType;
  dedupe_key: string;
  event: SourceEvent;
  /** The caller's listener lease token for `source_type`. */
  lease_token: number;
}

export interface InboxRow {
  seq: number;
  source_type: SourceType;
  dedupe_key: string;
  event: SourceEvent;
  received_at: Timestamp;
}

export type AppendInboxResult =
  | { ok: true; row: InboxRow; duplicate: boolean }
  | { ok: false; reason: "lease_lost" };

export interface ListenerLease {
  source_type: SourceType;
  owner: string;
  token: number;
  expires_at: Timestamp;
}

export type ListenerLeaseResult =
  | { ok: true; lease: ListenerLease }
  /** `holder`: the current lease, or null when there is none (renew of a lease that was never taken). */
  | { ok: false; reason: "held" | "lease_lost"; holder: ListenerLease | null };
