import type {
  Actor,
  BlockedOn,
  Handoff,
  Run,
  RunId,
  RunKind,
  RunOutcome,
  RunStatus,
  SourceRef,
  SourceType,
  StateChange,
  StateChangeDetail,
  Stage,
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
}

export interface NewRun {
  work_item_id: WorkItemId;
  kind: RunKind;
  idempotency_key: string;
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
}

export type TransitionResult =
  | { ok: true; item: WorkItem; state_change: StateChange; enqueued: Run | null }
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

export interface FactoryStore {
  migrate(): Promise<void>;
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
  /** The item whose factory PR in `project` has this number (oldest if several). */
  getWorkItemByPr(project: string, pr_number: number): Promise<WorkItem | null>;
  /** The item in `project` whose PR merged as this commit (oldest if several). */
  getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null>;
  /** Newest first. */
  listWorkItems(limit: number): Promise<WorkItem[]>;
  /** Items matching `filter`, most recently updated first. Read-only. */
  listWorkItemsWhere(filter: WorkItemFilter): Promise<WorkItem[]>;
  /** Number of work items in each stage. Every stage is present, 0 when it has none. Read-only. */
  countWorkItemsByStage(): Promise<Record<Stage, number>>;
  /** The only way to change a work item: conditional update + state_changes row (+ optional ack/enqueue). */
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

  // Runs

  /** Pull-based claim: oldest queued run of the given kinds → running, attempt + 1, new lease with token + 1. */
  claimRun(input: ClaimInput): Promise<Run | null>;
  /**
   * Extends the lease while the run is `running` with this `token`, whatever the clock says: a lease that
   * expired but was not reaped or reclaimed (host sleep) is renewed. lease_lost means stop work immediately.
   */
  heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult>;
  /** Records the outcome and clears the lease while the run is `running` with this `token`, even past `expires_at`. */
  completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult>;
  /** Finished runs the controller has not applied yet, oldest first. */
  listUnacknowledgedRuns(limit: number): Promise<Run[]>;
  /** Reaper: running runs whose lease expired → queued again, or failed once `attempt` (counted per claim) reached max_attempts. */
  expireLeases(max_attempts: number): Promise<RunId[]>;
  getRun(id: RunId): Promise<Run | null>;
  listRuns(id: WorkItemId): Promise<Run[]>;
  /** Runs (any item) in one of `statuses`, oldest first by created_at. Read-only. */
  listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]>;
  /**
   * Runs whose finished_at lies within the last `window_ms` of the store's clock, newest first. Runs that
   * finished before finished_at existed (null) are never included. Read-only.
   */
  listRunsFinishedWithin(window_ms: number): Promise<Run[]>;

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
}
