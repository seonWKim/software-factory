import type { TierHistory } from "../core/budget.js";
import type { ChildRestart } from "./updater.js";
import type { CoordinationSettings, DependencyLink } from "../core/coordination.js";
import type {
  Actor, BlockedOn, BudgetAnswer, BudgetCheckpoint, BudgetCheckpointId, ClaimDecision, ClaimPauseName, DependencyEdge, DependencyState, Tier,
  Handoff, FiledPattern, FiledPatternId, HostSleep, ImproveReport, ImproveReportId, ImproveWindow, Run, RunAttempt, RunId, RunInput, RunKind,
  RunOutcome, RunResume, RunStatus, SessionFinish, SourceRef, SourceType, StandingGate, StandingProposal, StandingRule, StateChange,
  StateChangeDetail, Stage, Timestamp, UnreviewedMerge, UserId, Verdict, VerdictKind, VerdictSeverity, VerdictTarget, WorkItem, WorkItemId,
  WorkItemPatch, WorkerId, WorkerPause,
} from "../core/types.js";
import type { LinkedAccount } from "./auth-provider.js";
import type { SourceEvent } from "./source-adapter.js";
import type { StatsRecord } from "../core/stats.js";
import type { MergeEvaluation } from "../core/merge-evaluation.js";
import type { LearnedSettingsStore } from "../core/learned-settings.js";
import type { CommandProposalStore } from "../core/interpret.js";
import type { TaskStore } from "../core/tasks.js";
import type { NoticeStore } from "../core/notifications.js";
import type { PostedCommentReads } from "../core/reaction-verdict.js";

// Contract for every implementation (SQLite now, Postgres later):
// - Each method is one transaction. A method either fully applies or changes nothing.
// - Time comes from the injected Clock (SystemClock in prod, FakeClock in tests). Method arguments never carry "now".
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
   * Adoption of a change a person opened (design 2026-11-01). Present: the item starts at REVIEW with
   * origin `adopted`, these fields set, done_criteria null, and the state change reason `pr_adopted`.
   */
  adopted?: AdoptedPr;
  /**
   * The item starts held (design 2026-11-01, split specs): `NEW` with this blocker instead of `blocked_on:
   * none`. A later phase of a split waits here until the phase before it closes as completed. Ignored with `adopted`.
   */
  hold?: { blocked_on: "upstream"; blocked_reason: string };
  /** A phase of a split spec (design 2026-11-01): its parent and its place in merge order (1-based). */
  parent?: { id: WorkItemId; phase: number };
}

export interface AdoptedPr {
  /** The PR number as text; the store mirrors it into its legacy PR column and writes change_url from it. */
  change_ref: string;
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
  manual: { actor: Actor; change_ref: string } | null;
}

export type RecordPrHeadResult =
  /** `run`: the manual run written, or null for a baseline. */
  | { ok: true; item: WorkItem; run: Run | null }
  | { ok: false; reason: "not_found" }
  /** last_head_sha is no longer `expected_head` (another poll or a factory push recorded first). Nothing written. */
  | { ok: false; reason: "head_moved"; current: WorkItem };

export interface NewUnreviewedMerge {
  project: string;
  /** The PR number as text; the store mirrors it into its legacy PR column. */
  change_ref: string;
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

/** The patterns the alarm step looks for across items (design 05-alarms); `spend_budget`: spend passed 80% or 100% of a budget (06-spend). */
/** `auto_stopped`: a stop condition set auto mode back to manual (design 03-risk); the controller stores it, not the alarm step. */
/** `dead_letter`: the bus dead-lettered a message (RFC 0015 §5.4); the controller's dead-letter-alarm handler stores it. */
export type AlertPattern = "repeated_error" | "zero_tokens" | "child_restarts" | "auto_stopped" | "dead_letter" | "spend_budget";

/** An alert as the alarm step builds it; the store adds `id` and `created_at`. */
export interface NewAlert {
  pattern: AlertPattern;
  /** The dedupe key: the pattern and a hash of its code and normalized detail, never the detail itself. */
  pattern_key: string;
  error_code: string;
  /** Runs (or restarts) that matched. */
  count: number;
  /** Egress-scanned before it is stored; null when the scanner flagged it (the code and count stay). */
  detail: string | null;
}

export interface Alert extends NewAlert { id: string; created_at: Timestamp }

/** An improve run's report as the improver builds it; the store adds `id` and `created_at`. */
export interface NewImproveReport extends ImproveWindow {
  run_id: RunId;
  project: string;
  groups: ImproveReport["groups"];
  patterns: ImproveReport["patterns"];
}

/** A filed pattern as claimed; the store adds `id` and `created_at`, and `filed_ref` starts null. */
export type NewFiledPattern = Omit<FiledPattern, "id" | "created_at" | "filed_ref" | "outcome" | "outcome_at">;

/** A standing-approval rule as written; the store adds the timestamps. */
export type NewStandingRule = Pick<StandingRule, "gate" | "tier" | "enabled" | "set_by">;

/** A standing-approval proposal as the run check finds it; the store adds `id` and `created_at`. */
export interface NewStandingProposal { gate: StandingGate; tier: Tier; run_length: number; threshold: number }

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
  /**
   * Stop every `running` run of this item, of any kind, in the same transaction: status `cancelled`, lease
   * cleared, no outcome, unacknowledged. The worker holding one gets `lease_lost` on its next heartbeat and
   * on completeRun (so its outcome is not stored), and the tool broker refuses its calls, so nothing it does
   * afterwards is pushed. Used when an item closes from its source (design §4). Each stopped run's open
   * attempt record closes as `cancelled`.
   */
  cancel_running_runs?: boolean;
}

/** How a base push finished: `pushed` (the remote base contains the merge) or `conflict` (it moved and does not merge). */
export type BasePushOutcome = "pushed" | "conflict";

/** A local merge's base push (RFC 0015 M8: outbound's `push_base` action), as the status page shows it. */
export interface BasePush {
  base_ref: string;
  merge_sha: string;
  /** Failed tries so far (an outage, a rate limit, a base that moved under the push): its batch's. */
  attempts: number;
  /** Null while pending. */
  outcome: BasePushOutcome | null;
  /** The remote base after a `pushed` outcome. */
  pushed_sha: string | null;
  last_error: string | null;
}

export type TransitionResult =
  /** `cancelled`: the runs `cancel_queued_runs` and `cancel_running_runs` cancelled (empty without them). */
  | { ok: true; item: WorkItem; state_change: StateChange; enqueued: Run | null; cancelled: RunId[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: WorkItem }
  /** ack_run was given but that run is not finished, belongs to another item, or is already acknowledged. */
  | { ok: false; reason: "run_not_ackable" };

/** One signal ledger row (design 11-signal-ledger): IDs, enum codes and times only, never text or a display name. */
export interface NewSignal {
  /** `source_ref`: the source record's key (a state change, verdict or run ID; `<run>:<finding>`), unique per source. */
  source: string; source_ref: string; kind: string; work_item_id: WorkItemId; role: string | null;
  /** The standing rule ID when a standing rule approved the item; null otherwise. */
  rule: string | null;
  at: Timestamp;
}

export interface RecordVerdictInput {
  id: WorkItemId;
  /** Applies only if the item's current version equals this. */
  expected_version: number;
  /** Explicit: the human who wrote it. Implicit: the person the event names, or a system actor when none resolves. */
  actor: Actor;
  verdict: VerdictKind;
  severity: VerdictSeverity;
  reason: string | null;
  /** The comment id, or an implicit verdict's event key. With `replace` (a one-tap verdict), a different verdict updates its row. */
  comment_id: string;
  target: VerdictTarget;
  implicit: boolean;
  pr_head: string | null;
  replace?: boolean;
}

export type RecordVerdictResult =
  | { ok: true; item: WorkItem; state_change: StateChange; verdict: Verdict }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: WorkItem }
  /**
   * A verdict from this comment is already stored (checked before the version), or, for an implicit verdict, one
   * for its PR head. `verdict` is the stored one. Nothing changed.
   */
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
  blocked_on?: BlockedOn | undefined; blocked_reason?: string | undefined;
  exclude_closed?: boolean | undefined; // Leave out CLOSED items. Ignored when `stage` is given.
  /** Only items updated at or after this time (with `stage: "CLOSED"`, the closes since then: owner notices). */
  updated_since?: Timestamp | undefined;
  limit: number;
}

export interface ClaimInput {
  worker_id: WorkerId;
  kinds: readonly RunKind[];
  lease_ms: number;
  /** The coordination threshold and weights (design §5, 2026-11-03). Absent: DEFAULT_COORDINATION. */
  coordination?: CoordinationSettings;
}

/** `/approve` on an implement run held by coordination cost (design §5, 2026-11-03). */
export interface ApproveClaimHoldInput {
  id: WorkItemId;
  /** Applies only if the item's current version equals this. */
  expected_version: number;
  /** The approver: recorded on the state change and on the claim decision. */
  actor: Extract<Actor, { kind: "user" }>;
  run_id: RunId;
}

export type ApproveClaimHoldResult =
  | { ok: true; item: WorkItem; state_change: StateChange; decision: ClaimDecision }
  | Exclude<TransitionResult, { ok: true }>
  /** The run is not a queued run of this item with a `held` claim decision. Nothing changed. */
  | { ok: false; reason: "not_held" };

/** A recorded merge conflict (design §5, 2026-11-03): `paths` conflicted in one event, named by `event_key`. */
export interface RecordConflictsInput {
  project: string;
  paths: readonly string[];
  /** Unique per conflict event (e.g. `<item id>:<base sha>`): recording the same event again counts nothing. */
  event_key: string;
}

/**
 * One attempt the reaper cut off (design §5 Restarts, issue #210). `ended_at` is the run's last heartbeat
 * (`updated_at` before the reaper's write); `duration_ms` is `ended_at − started_at`, null without `started_at`.
 */
export interface AbandonedAttempt {
  run_id: RunId;
  work_item_id: WorkItemId;
  attempt: number;
  /** What the reaper moved the run to. */
  outcome: "queued" | "failed" | "cancelled";
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  duration_ms: number | null;
}

export type LeaseResult ={ ok: true; run: Run } | { ok: false; reason: "lease_lost" };

/** `session start` (design §5, 2026-11-01): the item's transition plus one `interactive` run, written running. */
/** `actor`: the person (state change actor, run actor_id). `detail` gets `run_id`. `owner`: the lease owner, never a worker id. */
export interface StartSessionInput {
  id: WorkItemId; expected_version: number; actor: Extract<Actor, { kind: "user" }>; patch: WorkItemPatch; reason: string; detail: StateChangeDetail;
  owner: string; lease_ms: number; transcript_url: string | null;
}

export type StartSessionResult =
  /** `cancelled`: the item's queued triage runs. */
  | { ok: true; item: WorkItem; run: Run; state_change: StateChange; cancelled: RunId[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: WorkItem }
  | { ok: false; reason: "session_open" | "implement_run"; run_id: RunId }
  /** A running implement-type or interactive run of another item shares `paths` with this item's allowed_paths. */
  | { ok: false; reason: "overlap"; work_item_id: WorkItemId; run_id: RunId; paths: string[] };

/** What `session note`, `--tokens`, `--transcript` and `finish` write (scanned by the caller). `note` is appended, the rest replace. */
export interface SessionUpdate { note?: string; tokens?: number; transcript_url?: string; last_finish?: Omit<SessionFinish, "at"> }

/** `applied`: the highest migration recorded in the database (0 when none). `latest`: the highest this code has. */
export interface SchemaVersion { applied: number; latest: number }

/** A Slack notice as posted (design 05-sources, "Replies under a notice"): channel, ts, the work item IDs its lines name. */
export interface NoticeMessage { channel: string; ts: string; work_item_ids: string[]; created_at: Timestamp }
/** A reply under a several-item notice, kept for its which-item press: its ID (the Slack event ID), the notice and its words. */
export interface NoticeQuestion { id: string; channel: string; notice_ts: string; text: string; created_at: Timestamp }
/** The Slack source's notice records: each insert skips a stored key and says whether it inserted; a read finds none as null. */
export interface NoticeMessageStore {
  recordNoticeMessage(m: Omit<NoticeMessage, "created_at">): Promise<boolean>;
  getNoticeMessage(channel: string, ts: string): Promise<NoticeMessage | null>;
  recordNoticeQuestion(q: Omit<NoticeQuestion, "created_at">): Promise<boolean>;
  getNoticeQuestion(id: string): Promise<NoticeQuestion | null>;
}

export interface FactoryStore extends LearnedSettingsStore, CommandProposalStore, TaskStore, PostedCommentReads, NoticeStore, NoticeMessageStore {
  migrate(): Promise<void>;
  /**
   * Read-only probe for health checks: reaches the database and reads the applied schema version. Writes
   * nothing: no migration, no table creation, no lock. Throws when the database cannot be reached.
   */
  schemaVersion(): Promise<SchemaVersion>;
  close(): Promise<void>;

  // Work items

  /**
   * Idempotent on (source.type, source.id). Writes the "intake" state change (with `detail`, e.g. a phase's
   * parent link) and enqueues `enqueue` in the same transaction, only when created.
   */
  createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id">; detail?: StateChangeDetail },
  ): Promise<{ item: WorkItem; created: boolean }>;
  getWorkItem(id: WorkItemId): Promise<WorkItem | null>;
  getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null>;
  /**
   * The item in `project` whose PR (factory or adopted) has this change_ref (oldest if several). A row with
   * change_ref NULL (written by an older controller) is found by its legacy PR column.
   */
  getWorkItemByPr(project: string, change_ref: string): Promise<WorkItem | null>;
  /** The item in `project` whose PR merged as this commit (oldest if several). */
  getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null>;
  /** The phases of split parent `parentId`, in phase order (design 2026-11-01). Empty for any other item. Read-only. */
  listPhases(parentId: WorkItemId): Promise<WorkItem[]>;
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
   * Stores a verdict: bumps the version and writes a state_changes row (reason `human_verdict`, or `implicit_verdict`
   * when `implicit`; `actor` as actor, `changes` = {}) and a linked verdicts row (`replace`: or updates the comment's
   * row), in one transaction; no other field changes. Idempotent on `comment_id`. One verdict per PR head: an implicit
   * one is a `duplicate` when the item has one for `pr_head`; an explicit one first deletes those (state changes stay).
   */
  recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult>;
  /** The item's verdicts, oldest first. Read-only. */
  listVerdicts(id: WorkItemId): Promise<Verdict[]>;
  /**
   * Every work item (any stage, no cap), oldest first, with the reasons of its state changes that are in
   * `reasons` (in version order), the severities of its explicit verdicts (oldest first), the count of its
   * implicit ones, `pushed` (an implicit `changes` verdict is stored) and `merged` (CLOSED with close_reason
   * completed). For `factory stats` and Autonomy. Read-only.
   */
  listStatsRecords(reasons: readonly string[]): Promise<StatsRecord[]>;

  // Signal ledger (design 11-signal-ledger): every read is across items, oldest first, from `since` (null: all).
  /** Stores one signal; false (nothing written) when its (source, source_ref) is already stored. */
  recordSignal(s: NewSignal): Promise<boolean>;
  /** The newest `at` of each source's signals, by source; a source with none is absent. One read. */
  latestSignalTimes(): Promise<ReadonlyMap<string, Timestamp>>;
  /** The stored (source, source_ref) of each window's source with `at` from its `since`; [] for no window. One read. */
  listSignalRefs(windows: readonly { source: string; since: Timestamp }[]): Promise<{ source: string; source_ref: string }[]>;
  /** State changes with a reason in `reasons` (of `work_item_ids` when given), by at. Read-only. */
  listStateChangesSince(q: { reasons: readonly string[]; since: Timestamp | null; work_item_ids?: readonly WorkItemId[] }): Promise<StateChange[]>;
  /** Verdicts, by at. Read-only. */
  listVerdictsSince(since: Timestamp | null): Promise<Verdict[]>;
  /** Runs in `status` (of `kinds` when given), by finish time (`updated_at` on rows with none). Read-only. */
  listRunsFinishedSince(q: { status: RunStatus; kinds?: readonly RunKind[]; since: Timestamp | null }): Promise<Run[]>;
  /** Stored per-merge evaluations merged at or after `since` (null: all), oldest first (design 06-measurement). Read-only. */
  listMergeEvaluations(since: Timestamp | null): Promise<MergeEvaluation[]>;

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
   * skipped, never blocking the runs after it. Returns null while the `rate_limit`, `model_stall` or `network`
   * claim pause is in effect; while the `forge_auth` pause is, implement-type runs (implement, update) are skipped
   * and stay queued; while the `github_rate_limit` pause is, implement-type and review runs are skipped and stay
   * queued (triage and resolve claim).
   * Coordination (design §5, 2026-11-03), in the same transaction as the claim: a queued `implement` run is
   * skipped, and stays queued, while its item is `blocked_on: dependency` or has a dependency edge that is not
   * satisfied (state `merged`, or the work item of `depends_on` closed `completed` with a merge sha), and, for an
   * item with no PR, while its coordination cost against a holder is at or above `coordination.max_cost` (see
   * src/core/coordination.ts; files: pr_files, else files_to_change, else allowed_paths). Holders: items with an
   * implement-type run running, items with an open PR, other claimable queued implement runs. A run held only
   * by queued runs is claimed (the deadlock rule); a run with an approved hold is claimed. Every cost decision
   * is stored as the run's claim decision, rewritten only when it changes. Reads only the store.
   * Also null while `worker_pauses` holds a row for `input.worker_id` or the all-flag `*` (design §5 Pause). A run of an item held with `recurring_failure` (05-alarms) stays queued.
   * Sessions (design §5, 2026-11-01): an `interactive` run is never claimed; an implement-type run stays queued while
   * its item has an open session (a running interactive run) or its allowed_paths overlap one's.
   * A paused run (paused_at set) is claimed like any queued run, but the claim adds nothing to `attempt` and
   * clears paused_at and paused_by; its session_id and resume stay for the worker.
   * Every claim, a resume included, writes one `running` attempt record (design §6) in the same transaction.
   */
  claimRun(input: ClaimInput): Promise<Run | null>;
  /**
   * `workers pause <n>`: pauses the `count` workers, not paused yet, whose running runs started most recently
   * (one row each in `worker_pauses`). `workers pause --all` (`all: true`): the all-flag, so no loop claims,
   * idle ones included. Returns the worker ids paused by this call (`*` for the flag). Survives a restart.
   */
  pauseWorkers(input: { count: number } | { all: true }, by: string): Promise<{ paused: (WorkerId | "*")[] }>;
  /** `workers resume`: clears every worker pause and the all-flag. Returns how many rows went. */
  resumeWorkers(): Promise<{ cleared: number }>;
  /** The pause that applies to `worker_id` (its own row, else the all-flag), or null. Read-only. */
  workerPause(worker_id: WorkerId): Promise<WorkerPause | null>;
  /** Every worker pause row, the all-flag included, oldest first. Read-only. */
  listWorkerPauses(): Promise<WorkerPause[]>;
  /**
   * Puts a running run back in `queued` as paused, while it is `running` with this `token`: paused_at = now,
   * paused_by, session_id and resume set, lease cleared, no outcome, `attempt` unchanged, not acknowledgeable
   * (it is not finished). lease_lost when the run is no longer ours. Closes the claim's attempt record as `paused`.
   * `resume` null: nothing to reattach (the network pause requeues a run whose folder is gone), the next claim
   * starts it afresh, still with `attempt` unchanged.
   */
  pauseRun(runId: RunId, token: number, pause: { paused_by: string; session_id: string | null; resume: RunResume | null }): Promise<LeaseResult>;
  /**
   * Sets claim pause `name` (default `rate_limit`) until `resume_at`, for every work item and worker:
   * `rate_limit` stops every claim (a usage or rate limit), `forge_auth` stops implement-type claims (the forge
   * refused the credentials), `github_rate_limit` stops implement-type and review claims (the forge's rate limit, until
   * its reset). One `claim_pauses` row per name. Only ever moves a pause later. `extended` is true
   * when this call moved it, so exactly one caller logs it. For every name but `rate_limit`, `started` is true when this
   * call found no pause in effect (none yet, or the last one ended) and began one; it is decided by the same
   * conditional write, so among concurrent callers exactly one starts a pause (one owner comment per pause).
   * The `rate_limit` result has no `started`. The probe pauses (`model_stall`, `network`) stay in effect past
   * their time until a probe passes; `started` also writes their since row.
   */
  pauseClaims(resume_at: Timestamp, name?: ClaimPauseName): Promise<{ extended: boolean; started?: boolean; resume_at: Timestamp }>;
  /** The end of claim pause `name` (default `rate_limit`), or null if there is none or it has passed. Read-only. */
  getClaimPause(name?: ClaimPauseName): Promise<Timestamp | null>;
  /**
   * Ends claim pause `name` now (`factory resume`, the dashboard's "Resume now"; design §5 Restarts). `rate_limit`,
   * `forge_auth`, `preflight_access`: a row still in effect gets `resume_at` = now. A probe pause (`model_stall`,
   * `network`) in effect: its row and its answered row (`model_answered`, `network_answered`) move to the earlier
   * of the probe time and now, as a passing probe does, so its since row reads null too and a failure right after
   * starts a new pause. `ended` is true when a pause was in effect. A pause not in effect (none, already over, a
   * second call) changes no row. The since and answered rows are not pauses of their own and throw.
   */
  endClaimPause(name: ClaimPauseName): Promise<{ ended: boolean }>;
  /**
   * Takes the due probe of probe pause `name` (design §5 Restarts): while the pause is in effect with probe time
   * `due`, moves it to `next` with one conditional write under the claim lock, true for the one caller whose write
   * landed. Only that replica probes; every other one sees false (another took it, the time moved, or the pause
   * ended) and probes nothing. A moved, ended or missing pause changes no row and is never started again.
   */
  claimProbe(name: "model_stall" | "network", due: Timestamp, next: Timestamp): Promise<boolean>;
  /**
   * Extends the lease while the run is `running` with this `token`, whatever the clock says: a lease that
   * expired but was not reaped or reclaimed (host sleep) is renewed. lease_lost means stop work immediately.
   */
  heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult>;
  /**
   * Records the outcome and clears the lease while the run is `running` with this `token`, even past `expires_at`.
   * Closes the attempt record that claim opened (same token): status, error code, failure class, tokens.
   */
  completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult>;
  /** Finished runs the controller has not applied yet, oldest first. */
  listUnacknowledgedRuns(limit: number): Promise<Run[]>;
  /**
   * Reaper: running runs whose lease expired → queued again, or failed once `attempt` (counted per claim)
   * reached max_attempts. A requeued run gets `not_before` = now + `backoff_ms(attempt)` (absent: at once).
   * A run whose item is CLOSED is cancelled instead of requeued, so a closed item never runs again.
   * An `interactive` run is never requeued: it fails `session_lost` (design §5, 2026-11-01), and its attempt record
   * closes as `failed` with that code.
   * In every other case the claim's attempt record closes as `lease_expired`, failure class `infra`, tokens 0.
   * `onAbandoned` is called once per run this call's conditional update actually changed, after the
   * transaction commits (design §5 Restarts, issue #210). The returned ids are unchanged.
   */
  expireLeases(
    max_attempts: number,
    backoff_ms?: (attempt: number) => number,
    onAbandoned?: (attempt: AbandonedAttempt) => void,
  ): Promise<RunId[]>;
  getRun(id: RunId): Promise<Run | null>;

  /**
   * `session start` (design §5, 2026-11-01), one transaction under the claim lock. Refused with nothing written while
   * the item has a running interactive run or a queued or running implement-type run, or a running implement-type or
   * interactive run of another item overlaps its allowed_paths (after `patch`). Else: the transition, the item's
   * queued triage runs cancelled, and one `interactive` run inserted running (attempt 1, lease token 1).
   */
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  /** Writes `update` on the interactive run while it is `running` with this `token`; lease_lost otherwise. */
  updateSession(runId: RunId, token: number, update: SessionUpdate): Promise<LeaseResult>;
  /** Runs of `kind` in one of `statuses`, any item, oldest first. Read-only. */
  listRunsByKind(kind: RunKind, statuses: readonly RunStatus[]): Promise<Run[]>;
  listRuns(id: WorkItemId): Promise<Run[]>;
  /**
   * Every attempt record (one per claim, design §6) of the item's runs: runs in listRuns order, each run's
   * attempts in attempt order. Read-only.
   */
  listRunAttempts(id: WorkItemId): Promise<RunAttempt[]>;
  /** Runs (any item) in one of `statuses`, oldest first by created_at. Read-only. */
  listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]>;
  /**
   * Runs whose finished_at lies within the last `window_ms` of the store's clock, newest first. Runs that
   * finished before finished_at existed (null) are never included. Read-only.
   */
  listRunsFinishedWithin(window_ms: number): Promise<Run[]>;
  /** Runs whose finished_at is in [start, end), oldest first (finished_at, then insertion order). Read-only. */
  listRunsFinishedBetween(start: Timestamp, end: Timestamp): Promise<Run[]>;
  /**
   * Queues a run on an existing item with no transition (design §7: the improve run of a system work item, whose
   * state never changes). A run with the same idempotency key already there: that run, `created: false`.
   */
  enqueueRun(input: NewRun): Promise<{ run: Run; created: boolean }>;

  // Improve reports (design §7). One report per improve run; one filed pattern per (project, pattern key).

  /** Stores the report of `input.run_id`. A report for that run already there: that one, `created: false`. */
  recordImproveReport(input: NewImproveReport): Promise<{ report: ImproveReport; created: boolean }>;
  getImproveReport(run_id: RunId): Promise<ImproveReport | null>;
  /** The newest report of `project` (any project when absent), by created_at then ID; null when none. */
  getLatestImproveReport(project?: string): Promise<ImproveReport | null>;
  /** The reports of `project` created at or after `since`, oldest first. Read-only. */
  listImproveReports(project: string, since: Timestamp): Promise<ImproveReport[]>;
  /** Replaces the groups of report `id` (their filing written after the report). Unknown ID: no change. */
  setImproveGroups(id: ImproveReportId, groups: ImproveReport["groups"]): Promise<void>;
  getFiledPattern(project: string, pattern_key: string): Promise<FiledPattern | null>;
  /**
   * Claims the filing of (project, pattern key) for `input.report_id`, with no item yet. A row already there is
   * returned unchanged, unless `replace` names its report: then that row is claimed for `input.report_id` with
   * no item and no outcome (a refiled pattern), a conditional update, so of two claims one wins. Returns the row as stored.
   */
  claimFiledPattern(input: NewFiledPattern, replace?: ImproveReportId): Promise<FiledPattern>;
  /** Sets the item of the row `id` while `report_id` still holds it; a row another report claimed is left alone. */
  setFiledPatternRef(id: FiledPatternId, report_id: ImproveReportId, ref: SourceRef): Promise<void>;
  /** The filed patterns of `project` that have an item and no outcome yet, oldest first. Read-only. */
  listFiledPatternsWithoutOutcome(project: string): Promise<FiledPattern[]>;
  /** Sets the outcome of row `id` only while it has none: true when this call wrote it, false when one was there. */
  setFiledPatternOutcome(id: FiledPatternId, outcome: NonNullable<FiledPattern["outcome"]>, at: Timestamp): Promise<boolean>;

  // Standing approvals (design 05-standing-approvals). Stored only: nothing acts on a rule or a proposal yet.

  /** Writes the rule of (gate, tier): a new row, or the stored row's `enabled` and `set_by` with a new `updated_at`. */
  putStandingRule(input: NewStandingRule): Promise<StandingRule>;
  /** Every rule, by gate then tier. */
  listStandingRules(): Promise<StandingRule[]>;
  /**
   * Stores one proposal per (gate, tier, run_length). One already there: that one, `created: false`, nothing
   * written (another replica or a second pass found the same run).
   */
  recordStandingProposal(input: NewStandingProposal): Promise<{ proposal: StandingProposal; created: boolean }>;
  /** Every proposal, by gate, tier, then run length. */
  listStandingProposals(): Promise<StandingProposal[]>;

  // Coordination (design §5, 2026-11-03)

  /**
   * Makes `links` the item's edges: new ones are inserted `open`, kept ones keep their state, others are deleted.
   * Idempotent. Returns the item's edges. With `read_at` (the issue's updated_at the links were read at, issue #254)
   * every edge and the item record it, in the same transaction; without it both keep what they had.
   */
  replaceDependencyEdges(id: WorkItemId, links: readonly DependencyLink[], read_at?: Timestamp): Promise<DependencyEdge[]>;
  /**
   * The issue updated_at the item's links were last read at (`replaceDependencyEdges` with `read_at`), kept on the
   * item so an issue with no links has one too. Null: never read with a time, or marked stale. Read-only.
   */
  dependencyLinksReadAt(id: WorkItemId): Promise<Timestamp | null>;
  /** Clears the item's read time, so the controller reads its links on the next poll. Idempotent. */
  markDependencyLinksStale(id: WorkItemId): Promise<void>;
  /** Edges of one item, or every edge pointing to one source id, or every edge. Read-only. */
  listDependencyEdges(filter?: { work_item_id?: WorkItemId; depends_on?: string }): Promise<DependencyEdge[]>;
  /** Sets one edge's state. False when there is no such edge. */
  setDependencyState(id: WorkItemId, depends_on: string, state: DependencyState): Promise<boolean>;
  /** Records one conflict on each path; a path already recorded for this event_key counts once. Returns the new rows. */
  recordConflicts(input: RecordConflictsInput): Promise<number>;
  /** Recorded conflicts per path in `project`. Read-only. */
  conflictCounts(project: string): Promise<Map<string, number>>;
  /** The item's claim decisions, oldest first. Read-only. */
  listClaimDecisions(id: WorkItemId): Promise<ClaimDecision[]>;
  /** The latest claim decision of each of the items that has one, in one read (the Items page, one read for every row). Read-only. */
  listLatestClaimDecisions(ids: readonly WorkItemId[]): Promise<Map<WorkItemId, ClaimDecision>>;
  /**
   * `/approve` on a held run: bumps the version and writes a state change (reason `coordination_approved`, the
   * approver as actor, detail = run id, holder, cost, threshold) and sets the decision's `approved_by`, in one
   * transaction. The next claim takes the run whatever its cost.
   */
  approveClaimHold(input: ApproveClaimHoldInput): Promise<ApproveClaimHoldResult>;

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

  /** Idempotent on (project, change_ref): a second call returns the first row with created false. */
  recordUnreviewedMerge(input: NewUnreviewedMerge): Promise<{ merge: UnreviewedMerge; created: boolean }>;
  /** Newest first. Read-only. */
  listUnreviewedMerges(limit: number): Promise<UnreviewedMerge[]>;
  /** How many rows were recorded at or after `since`. Read-only. */
  countUnreviewedMergesSince(since: Timestamp): Promise<number>;

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
   * Takes `source_type`'s listener lease for `owner` if nobody holds it or the holder's lease expired;
   * the token goes up by one on every take. Otherwise reports the current holder.
   */
  acquireListenerLease(source_type: SourceType, owner: string, lease_ms: number): Promise<ListenerLeaseResult>;
  /** Extends the lease while `token` is still current, whatever the clock says (like heartbeat). */
  renewListenerLease(source_type: SourceType, token: number, lease_ms: number): Promise<ListenerLeaseResult>;
  /** Ends the lease now if `token` is still current, so another replica can take it at once. */
  releaseListenerLease(source_type: SourceType, token: number): Promise<void>;

  // Sync leases (design 05-coordination, sync lease): one replica per `sync:<type>:<project>` polls a sync source's
  // inbox and delivers its outbox. Same rules as the listener lease, keyed by name; `listener_leases` is its own table.

  /**
   * Takes lease `name` for `owner` if nobody holds it, the holder's lease expired, or `owner` already holds it
   * (then the token stays and the lease is extended). The token goes up by one on every take by a new owner.
   * Otherwise reports the current holder.
   */
  acquireSyncLease(name: string, owner: string, lease_ms: number): Promise<SyncLeaseResult>;
  /** Extends the lease while `token` is still current, whatever the clock says (like heartbeat). */
  renewSyncLease(name: string, token: number, lease_ms: number): Promise<SyncLeaseResult>;
  /** Ends the lease now if `token` is still current, so another replica can take it at once. */
  releaseSyncLease(name: string, token: number): Promise<void>;
  /** The lease row, expired or not; null when it was never taken. Read-only. */
  getSyncLease(name: string): Promise<SyncLease | null>;
  // Retention (design 08-retention, its guards): rows deleted by table, at most `limit` each, older than `older_than_ms`.
  pruneDeliveredOutbox(older_than_ms: number, limit: number): Promise<Record<string, number>>;
  pruneHandledCommands(older_than_ms: number, limit: number): Promise<Record<string, number>>;
  pruneRecords(older_than_ms: number, limit: number): Promise<Record<string, number>>;
  // Forge budget (design 05-sources, call budget): the forge's rate limit as its last response anywhere reported it,
  // one row per (project, plugin), shared by every replica.

  /** The row of `project` and `plugin`, or null. Read-only. */
  getForgeBudget(project: string, plugin: string): Promise<ForgeBudget | null>;
  /**
   * Stores `b` when there is no row yet or the stored row's `updated_at` is older than `b.updated_at`; an equal or
   * older write changes nothing. Returns whether this call wrote.
   */
  putForgeBudget(b: ForgeBudget): Promise<boolean>;

  // Identity links (design 2026-11-01, issue #107)

  /** The factory user `(provider, subject)` is linked to, or null. Found by provider and subject only. */
  resolveLink(provider: LinkedAccount["provider"], subject: string): Promise<UserId | null>;
  /** Every account linked to `user_id`, oldest first. */
  listLinks(user_id: UserId): Promise<LinkedAccount[]>;
  /**
   * Stores a one-time code that links an account to `user_id`, valid for LINK_CODE_TTL_MS. Only a hash of
   * `code` is stored; the caller shows the code once and keeps it nowhere.
   */
  createLinkCode(user_id: UserId, code: string): Promise<{ expires_at: Timestamp }>;
  /**
   * Links `account` to the code's user and uses the code up, in one transaction. A code that matches no live
   * code is a failed attempt: every live code's failure count goes up by one, and one with
   * LINK_CODE_MAX_FAILURES failures is locked. A redelivery by the account that used the code reports the same
   * link and changes nothing. An account linked to another user is refused and the code stays live.
   */
  redeemLinkCode(code: string, account: LinkedAccount): Promise<RedeemLinkResult>;

  // Local users (issue #318): who may act from the local CLI and UI under the `local` auth plugin.

  /** The local user row for `user_id`, or null. */
  getLocalUser(user_id: UserId): Promise<LocalUser | null>;
  /** Every local user, the owner first, then oldest first. */
  listLocalUsers(): Promise<LocalUser[]>;
  /**
   * Makes `user_id` the owner when the store has no owner yet, and returns the owner (the existing one, or
   * `user_id`). At most one owner, whatever replicas or terminals race: a second claim returns the first owner.
   */
  claimLocalOwner(user_id: UserId): Promise<LocalUser>;
  /** Gives a non-owner user `role` (added or changed). The owner's row is never changed by this. */
  setLocalUserRole(user_id: UserId, role: Exclude<LocalRole, "owner">, added_by: UserId): Promise<{ ok: true; created: boolean } | { ok: false; reason: "owner" }>;
  /** Removes a non-owner user's row. */
  removeLocalUser(user_id: UserId): Promise<"removed" | "missing" | "owner">;

  // Runtime settings overrides (design 2026-11-03): rows as given; the caller checks keys and values (core/settings.ts).

  /** Every stored override, ordered by key, then project. Read-only. */
  listSettingOverrides(): Promise<SettingOverride[]>;
  /**
   * Stores `value` for (key, project), replacing any earlier one, and appends one audit row with the old and
   * new value, in one transaction: if the audit insert fails, the override is unchanged. Concurrent sets:
   * last writer wins, and the audit rows keep the order they committed in.
   */
  setSettingOverride(input: SetSettingInput): Promise<SettingChange>;
  /**
   * Deletes the override of (key, project) and appends one audit row with `new_value` null, in one
   * transaction. Null, with nothing written, when there is no override to delete.
   */
  resetSettingOverride(input: ResetSettingInput): Promise<SettingChange | null>;
  /** Audit rows, newest first, at most `limit`. Read-only. */
  listSettingChanges(limit: number): Promise<SettingChange[]>;

  // Worker processes (design §5 Coordination, 2026-11-07). One row per running WorkerPool, keyed by its
  // `process_id`, written once per tick, so a reader on any host sees every process's slots.

  /**
   * Writes the snapshot of one process, keyed by `process_id`: a repeat write replaces the row. `reported_at`
   * is the store clock's now. Returns the stored row.
   */
  reportWorkerProcess(report: WorkerProcessReport): Promise<WorkerProcess>;
  /**
   * Live processes: rows whose `reported_at` is at most `max_age_ms` old (a row a dead process left behind is
   * not listed once it is older). Ordered by host, then pid, then process_id. Read-only.
   */
  listWorkerProcesses(max_age_ms: number): Promise<WorkerProcess[]>;
  /** Deletes the row of `process_id` (a clean stop). Returns whether a row went. */
  removeWorkerProcess(process_id: string): Promise<boolean>;

  // Host sleeps (design §5 Host sleep, issue #218).

  /**
   * Stores one host sleep. Keyed by (worker_id, woke_at): a sleep already stored is a no-op that reports the
   * stored row with `created: false`, so the write is safe to run twice.
   */
  recordHostSleep(sleep: HostSleep): Promise<{ created: boolean; sleep: HostSleep }>;
  /**
   * The newest host sleeps first (woke_at, then worker_id, both descending), at most `limit`. With
   * `work_item_id`: only sleeps recorded during one of that item's runs. Read-only.
   */
  listHostSleeps(opts: { limit: number; work_item_id?: WorkItemId }): Promise<HostSleep[]>;

  // Alerts (design 05-alarms): one row per pattern the alarm step saw, at most one per pattern per dedupe window.

  /**
   * Stores `alert` unless its pattern already alerted within `dedupe_ms` of the store clock's now. One
   * transaction with a conditional write on the pattern's row, so replicas recording one pattern at once store
   * one alert; the one that did gets `created: true`.
   */
  recordAlert(alert: NewAlert, dedupe_ms: number): Promise<{ created: true; alert: Alert } | { created: false }>;
  /** The newest alerts first (created_at, then id, both descending), at most `limit`. Read-only. */
  listAlerts(opts: { limit: number }): Promise<Alert[]>;

  // Restart history (design 05-restarts): one row per unexpected child exit, so the restart alarm's count and
  // window survive a restart of the factory and every replica on a shared store sees every host's restarts.

  /**
   * Stores one child restart unless the same restart (its time and reason) is stored already: one conditional
   * insert, so applying the same restart twice, or from two replicas at once, leaves one row. `created` says
   * whether this call stored it.
   */
  recordChildRestart(restart: ChildRestart): Promise<{ created: boolean }>;
  /** The child restarts at or after the store clock's now minus `window_ms`, oldest first. Read-only. */
  listChildRestartsWithin(window_ms: number): Promise<ChildRestart[]>;

  // Merge checks (design §5 Merge check, issue #248): the latest local merge check of each ready-to-merge item.

  /**
   * Stores `check` as the item's one latest result, replacing any earlier one; `checked_at` is the store clock's
   * now. Returns the stored row.
   */
  recordMergeCheck(check: NewMergeCheck): Promise<MergeCheck>;
  /** The item's latest result; null when it was never checked. Read-only. */
  getMergeCheck(work_item_id: WorkItemId): Promise<MergeCheck | null>;
  /** The latest results of the given items (those with one), in no set order. Read-only. */
  listMergeChecks(work_item_ids: readonly WorkItemId[]): Promise<MergeCheck[]>;

  // Sync source records (design §5, call budget; their reads by comment ID and time window: PostedCommentReads): the comments a source
  // posted and the labels it wrote, shared by every replica, so none needs a thread or label read to know them. Keyed by source id; only a sync source writes them.

  /**
   * The comment with `marker` on `source_id`, or a row of failed posts only (`comment_id` null). `same_body`
   * says whether `body` hashes to the stored body hash (false when none is stored); `waiting`, whether its next
   * attempt time is still ahead of the store clock. Read-only.
   */
  getPostedComment(source_id: string, marker: string, body: string): Promise<(PostedComment & { same_body: boolean; waiting: boolean }) | null>;
  /**
   * Stores the posted comment (ID, URL and the hash of `body`) and clears its failed attempts. A marker already
   * posted keeps its first record, so a second call changes nothing.
   */
  recordPostedComment(input: NewPostedComment): Promise<void>;
  /**
   * Records failed post number `attempts`; the next may be tried `delay_ms` after the store clock's now.
   * Conditional: only when the stored count is `attempts - 1` (no row counts as 0), so two replicas recording the
   * same failure count it once. Returns whether this call recorded it.
   */
  recordCommentFailure(source_id: string, marker: string, attempts: number, delay_ms: number): Promise<boolean>;

  /**
   * Claims the write of `status` on `target` of `source_id` for `ttl_ms`: a token, or null when the stored label
   * state is already `status` or another unexpired claim is writing the same status. One claim per write.
   */
  claimLabelWrite(source_id: string, target: LabelTarget, status: string, ttl_ms: number): Promise<string | null>;
  /** Stores `status` as written and ends claim `token`. A claim another write took over stores nothing. */
  recordLabelState(source_id: string, target: LabelTarget, status: string, token: string): Promise<void>;
  /** Ends claim `token` with nothing written (the write failed), so the next write need not wait for its expiry. */
  releaseLabelClaim(source_id: string, target: LabelTarget, token: string): Promise<void>;
  /** The stored label states of the given source ids, in no set order. Read-only. */
  listLabelStates(source_ids: readonly string[]): Promise<LabelState[]>;

  // The item thread and the command inbox (issues #198, #281, #282): every message the controller sends about an
  // item, and the commands the CLI and the app send, which the controller reads by seq.

  /**
   * Stores one message for `work_item_id`. `marker` identifies it within the item: a marker already stored
   * for that item is a no-op that reports the existing message with `created: false`.
   */
  recordItemMessage(input: NewItemMessage): Promise<{ created: boolean; message: ItemMessage }>;
  /**
   * Stores a run's keyed write for outbound (RFC 0015 M7: a push or a PR), which the controller's outbox step
   * announces. A key already stored is a no-op, so a step re-run after a restart writes each once.
   */
  recordRunIntent(intent: RunIntent): Promise<void>;
  /** The messages of `work_item_id` only, oldest first. Empty for an item with none. Read-only. */
  listItemMessages(work_item_id: WorkItemId): Promise<ItemMessage[]>;
  /**
   * Appends one CLI command. Its `seq` is greater than every command appended before it. A `key` already
   * stored is a no-op that reports the existing command with `created: false`.
   */
  appendCliCommand(input: NewCliCommand): Promise<{ created: boolean; command: CliCommand }>;
  /** Commands with seq > `after_seq`, in seq order, at most `limit`. Read-only. */
  listCliCommandsAfter(after_seq: number, limit: number): Promise<CliCommand[]>;
  /**
   * Commands appended with `mirror` and not marked mirrored yet, in seq order, at most `limit` (the CLI's commands
   * on items of a sync source). Read-only.
   */
  listUnmirroredCliCommands(limit: number): Promise<CliCommand[]>;
  /**
   * Marks command `key` mirrored now. Conditional: only a command appended with `mirror` and not marked yet
   * changes, so a second mark (a retry, another replica) changes nothing and returns false. Returns whether this
   * call marked it.
   */
  markCliCommandMirrored(key: string): Promise<boolean>;

  // The outbox (issue #282, design 05-sources "Thread first"): every factory message is a thread entry first; an
  // entry written with `delivery` gets one outbox row, which the controller's outbox step delivers to its target
  // source once, retrying with backoff. Delivery never changes the item's stage, blocked fields or version.

  /**
   * The undelivered outbox rows of the given source types whose retry time has come and that no live claim
   * holds, oldest first, at most `limit`. Rows of any other source type stay pending. Read-only.
   */
  listPendingDeliveries(source_types: readonly SourceType[], limit: number): Promise<ThreadDelivery[]>;
  /** Every outbox row of `work_item_id`, delivered or not, oldest first. Read-only. */
  listDeliveries(work_item_id: WorkItemId): Promise<ThreadDelivery[]>;
  /**
   * Claims outbox row `seq` for `lease_ms`, so only one replica posts it. Conditional: only an undelivered row
   * with no live claim and, with `fence`, only while `fence.token` is still the token of sync lease `fence.name`.
   * Returns the claim token, or null when the row is delivered, claimed by another, or the fence is stale.
   */
  claimDelivery(seq: number, lease_ms: number, fence?: SyncFence): Promise<number | null>;
  /** Outbox row `seq` with its thread entry, or null. Read-only. */
  getDelivery(seq: number): Promise<ThreadDelivery | null>;
  /**
   * Marks row `seq` delivered with the comment's `url`, under claim `token` (outbound). Returns false, changing
   * nothing, when the token is no longer the row's live claim.
   */
  finishDelivery(seq: number, token: number, url: string | null): Promise<boolean>;
  /**
   * Records a delivered row on its item (the controller, on DeliveryCompleted): when the row names a link field
   * and no newer row of the item names the same field, the item's field is set to the row's URL (no version
   * change, no state change). An undelivered row, or one with no URL, changes nothing.
   */
  linkDelivery(seq: number): Promise<void>;
  /**
   * Records a failed delivery of row `seq` under claim `token`: one more attempt, the error, the claim released
   * and the next try `retry_in_ms` from now. Returns false, changing nothing, when the token is not the claim.
   */
  failDelivery(seq: number, token: number, error: string, retry_in_ms: number): Promise<boolean>;

  /**
   * The newest base push of `work_item_id` (design 05-sources, Local items; RFC 0015 M8: the `push_base` action a
   * delivered merge stored), delivered or not; null when its merge stored none. Read-only.
   */
  getBasePush(work_item_id: WorkItemId): Promise<BasePush | null>;

  // App command requests (issue #245): commands sent from the factory's own app, applied by the controller tick
  // through the same path as a comment command. Created by the status page's POST /api/v1/items/:id/commands (#227).

  /**
   * Records one request, pending (handled_at and refusal null). Its `seq` is greater than every request recorded
   * before it. A `key` already stored is a no-op that reports the existing request with `created: false`.
   */
  recordAppCommandRequest(input: NewAppCommandRequest): Promise<{ created: boolean; request: AppCommandRequest }>;
  /**
   * Marks request `seq` handled now, with `refusal` (null: applied). Conditional: only a pending request changes,
   * so a second mark of the same request changes nothing and returns false. Returns whether this call marked it.
   */
  markAppCommandRequest(seq: number, refusal: string | null): Promise<boolean>;
  /** The request with `seq` (a number) or idempotency key (a string), or null. Read-only. */
  getAppCommandRequest(ref: number | string): Promise<AppCommandRequest | null>;
  /** The requests whose `args.work_item_id` is `id`, oldest first, the newest `limit`; handled or not. Read-only (the item API's `replies`). */
  listAppCommandRequestsForItem(id: WorkItemId, limit: number): Promise<AppCommandRequest[]>;
  /** The CLI's (args `item`) and the dashboard's (args `work_item_id`) commands for item `id`, oldest first, the newest `limit`.
   *  A comment's command is left out: its comment is a thread entry. Read-only. */
  listItemCommands(id: WorkItemId, limit: number): Promise<CliCommand[]>;

  // Raw table reads for the dashboard's Data page (design §9, issue #239). Read-only. Table and column names
  // come from the database's own catalog, never from the caller: an unknown name is refused, not built into
  // SQL, and a filter value is always a bound parameter. Callers withhold secret columns themselves.

  /** Every table of the backend's schema, by name, with its row count, columns and the order a page uses. */
  listTables(): Promise<StoreTable[]>;
  /**
   * One page of `table`'s rows, newest first by its `order_by` columns, with the total row count (after the
   * filter). `limit` defaults to TABLE_PAGE_DEFAULT and is capped at TABLE_PAGE_MAX; `offset` defaults to 0.
   * Null, with no row read, when the table or the filter's column is not in the schema.
   */
  listTableRows(input: TablePageInput): Promise<TablePage | null>;
}

/** Rows a table page returns when no limit is given. */
export const TABLE_PAGE_DEFAULT = 50;
/** The most rows one table page returns. */
export const TABLE_PAGE_MAX = 200;

/** One table of the store's schema. */
export interface StoreTable {
  name: string;
  rows: number;
  /** Column names in schema order. */
  columns: string[];
  /** Primary-key columns in key order; empty when the table has none. */
  primary_key: string[];
  /**
   * Columns a page sorts by, all descending: the first of created_at, at, started_at, updated_at the table
   * has, then its primary key; empty for a table with neither (rows in the database's own order).
   */
  order_by: string[];
}

/** A cell as read: text, a number, or null. Other driver types (dates, big integers, bytes) become text. */
export type TableCell = string | number | null;

export interface TablePageInput {
  table: string;
  limit?: number;
  offset?: number;
  /** Exact-value match on one column, bound as a parameter. */
  filter?: { column: string; value: string };
}

export interface TablePage {
  rows: Record<string, TableCell>[];
  /** Rows matching the filter (all rows without one). */
  total: number;
  /** The limit applied, after the default and the cap. */
  limit: number;
  offset: number;
}

/** Where a status label goes: the item's own issue, or its PR by change_ref (`pr:34`). */
export type LabelTarget = "issue" | `pr:${string}`;

export function labelTarget(change_ref: string | null): LabelTarget {
  return change_ref === null ? "issue" : `pr:${change_ref}`;
}

/** The status label last written on one target of one item. */
export interface LabelState {
  source_id: string;
  target: LabelTarget;
  /** Null while a first write is claimed but not done. */
  status: string | null;
  updated_at: Timestamp;
}

export interface NewPostedComment {
  source_id: string;
  marker: string;
  comment_id: string;
  url: string | null;
  /** The body as posted; the store keeps only its hash. */
  body: string;
}

export interface PostedComment {
  source_id: string;
  marker: string;
  /** Null on a row that only counts failed posts. */
  comment_id: string | null;
  url: string | null;
  body_hash: string | null;
  /** Failed posts since the last one that went through. */
  attempts: number;
  /** When the next post may be tried; null with no failures. */
  next_attempt_at: Timestamp | null;
}

export interface NewItemMessage {
  work_item_id: WorkItemId;
  /** Unique within the item; a repeat with the same marker stores nothing. */
  marker: string;
  body: string;
  /**
   * Who wrote it when it came from a source: the account's ID (`<provider>:<numeric id>`), never a login or a
   * display name. Absent for the factory's own messages (and on entries stored before it existed).
   */
  actor?: string;
  /**
   * Present: the entry also gets one outbox row in the same transaction (only when the entry is new), so the
   * controller's outbox step delivers it to that source. Absent or null: the thread is the only copy.
   */
  delivery?: NewThreadDelivery | null;
}

/** The item fields an outbox delivery fills with the delivered comment's URL. */
export type ThreadLinkField = "spec_comment_url" | "failure_comment_url";

/** Where a thread entry is delivered: one source, one target on it. */
export interface NewThreadDelivery {
  /** The adapter type that delivers it: always the item's own source type. */
  source_type: SourceType;
  /** What the adapter posts on: the item's source, or (same type) its PR. */
  target: SourceRef;
  /** The item field the delivered URL fills, if any. */
  link_field?: ThreadLinkField | null;
}

export interface ThreadDelivery {
  seq: number;
  thread_seq: number;
  work_item_id: WorkItemId;
  source_type: SourceType;
  target: SourceRef;
  link_field: ThreadLinkField | null;
  /** The thread entry's marker and body, as posted. */
  marker: string;
  body: string;
  /** Failed deliveries so far. */
  attempts: number;
  /** When the next try may run. */
  next_attempt_at: Timestamp;
  delivered_at: Timestamp | null;
  url: string | null;
  last_error: string | null;
  created_at: Timestamp;
}

export interface ItemMessage extends NewItemMessage {
  seq: number;
  /** Store clock's now when the message was first recorded. */
  created_at: Timestamp;
}

export interface NewCliCommand {
  /** Idempotency key, unique across all commands: a repeat with the same key stores nothing. */
  key: string;
  /** The ID of whoever ran the command (e.g. `local:<login>`), never a display name. */
  actor: string;
  /** The command's name. */
  command: string;
  /** The command's arguments, stored as JSON. */
  args: Record<string, unknown>;
  /** Mirrored once to its item's sync source, best effort: listed by `listUnmirroredCliCommands` until marked. */
  mirror?: boolean;
  /** The edge passport the command entered with (RFC 0015 §8, Identity); absent on rows from before M9. */
  passport_id?: string;
}

export interface CliCommand extends NewCliCommand {
  seq: number;
  /** Its id (CommandReceived carries it) and origin (`cli`, `app`, or the provider of a comment poll), RFC 0015 D7. */
  id: string;
  origin: string;
  /** Store clock's now when the command was first appended. */
  created_at: Timestamp;
}

export interface NewAppCommandRequest {
  /** Idempotency key, unique across all requests: a repeat with the same key stores nothing. */
  key: string;
  /** The factory user who sent the request, never a display name. */
  actor: UserId;
  /** The command's name, e.g. `approve`. Only `approve` is applied; any other gets a refusal. */
  command: string;
  /** The command's arguments, stored as JSON: `work_item_id`, and for `approve` an optional `note`. */
  args: Record<string, unknown>;
  /** The page's edge passport (RFC 0015 §8, Identity); absent when the UI has no Identity. */
  passport_id?: string;
}

export interface AppCommandRequest extends NewAppCommandRequest {
  seq: number;
  /** Store clock's now when the request was first recorded. */
  created_at: Timestamp;
  /** When the controller handled it (applied or refused); null while pending. */
  handled_at: Timestamp | null;
  /** The refusal text posted for it; null when applied or pending. */
  refusal: string | null;
}

/** One local merge check: whether the PR's head merged cleanly into the base, as git computed it. */
export interface NewMergeCheck {
  work_item_id: WorkItemId;
  mergeable: boolean;
  /** Conflicting file paths, sorted; empty when mergeable. Free text from the repository. */
  conflicts: string[];
  head_sha: string;
  base_sha: string;
}

export interface MergeCheck extends NewMergeCheck {
  checked_at: Timestamp;
}

/** What a WorkerPool reports each tick. */
export interface WorkerProcessReport {
  /** `<host>:<pid>`, the pool's worker id prefix: the row's key. */
  process_id: string;
  pid: number;
  host: string;
  /** Slots that may claim now: the live `workers`, capped at `max_slots`. 0 while draining. */
  slots: number;
  /** The slot count: the file's `max_workers` (absent: `workers`). */
  max_slots: number;
  /** Slots holding a run at the moment of the write. */
  busy: number;
  /** The first worker index; the process's worker ids are `<process_id>:<index_base … index_base + max_slots - 1>`. */
  index_base: number;
  /** When the pool started. */
  started_at: Timestamp;
}

export interface WorkerProcess extends WorkerProcessReport {
  reported_at: Timestamp;
}

/** One stored override. `project` is "" for a global override, else a project key. `value` is JSON text. */
export interface SettingOverride {
  key: string;
  project: string;
  value: string;
  /** The actor's ID (e.g. `local:<OS login>`), never a display name. */
  set_by: string;
  set_at: Timestamp;
}

/** One audit row of a set or reset. `old_value` null: there was no override. `new_value` null: a reset. */
export interface SettingChange {
  seq: number;
  key: string;
  project: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  at: Timestamp;
}

export interface SetSettingInput {
  key: string;
  /** "" for global. */
  project: string;
  /** JSON text. */
  value: string;
  actor: string;
}

export interface ResetSettingInput { key: string; project: string; actor: string }

/** How long a link code works (design 2026-11-01). */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes after which every live code is locked. */
export const LINK_CODE_MAX_FAILURES = 5;

/** A local user's role (issue #318): `owner` (one, the first identity; may manage users) > `approver` > `requester`. */
export type LocalRole = "owner" | "approver" | "requester";

export interface LocalUser {
  user_id: UserId;
  role: LocalRole;
  /** Who added the row: the owner's own ID for the owner. */
  added_by: UserId;
  created_at: Timestamp;
}

export type RedeemLinkResult =
  | { ok: true; user_id: UserId }
  | { ok: false; reason: "invalid" | "expired" | "used" | "locked" | "already_linked" };

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

/** A sync lease row: `name` is `sync:<source type>:<project key>`. */
export interface SyncLease {
  name: string;
  owner: string;
  token: number;
  expires_at: Timestamp;
}

export type SyncLeaseResult =
  | { ok: true; lease: SyncLease }
  /** `holder`: the current lease, or null when there is none (renew of a lease that was never taken). */
  | { ok: false; reason: "held" | "lease_lost"; holder: SyncLease | null };

/** A sync lease token a write is fenced with: the write lands only while `token` is the lease's current one. */
export interface SyncFence {
  name: string;
  token: number;
}

/**
 * The forge's rate limit as a response last reported it, for one project (its key, column `project_key`) and forge
 * plugin. `updated_at`: when the
 * writer read that response (its clock); a newer one replaces the row, an older one never does.
 */
export interface ForgeBudget {
  project: string;
  plugin: string;
  remaining: number;
  limit: number;
  reset_at: Timestamp;
  updated_at: Timestamp;
}

/** A run's keyed write to the forge (RFC 0015 M7): `push` the stored sha to its branch, then `pr` open or update. */
export interface RunIntent {
  readonly action: "push" | "pr";
  /** The destination: the host whose factory repo holds the commit, and the branch (`git:<host>:<branch>`). */
  readonly target: SourceRef;
  readonly work_item_id: string;
  readonly args: Readonly<Record<string, string | number | null>>;
  readonly key: string;
}
