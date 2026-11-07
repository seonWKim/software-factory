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
/**
 * `dependency` (design 2026-11-03): the item's implement run waits for a linked item (`Depends on: #N`, a
 * sub-issue, a blocked-by link) to merge. Its status label is "implementing", never "needs human".
 */
export type BlockedOn = "none" | "human" | "upstream" | "ci" | "budget" | "dependency";
export type CloseReason = "completed" | "duplicate" | "wont_do" | "failed" | "rejected";
export type Tier = 1 | 2 | 3 | 4 | 5;

/** The source adapter's type, e.g. `local`: an item filed on this machine (issue #198). Core names no other source. */
export type SourceType = string;

/**
 * Where an item came from (design 2026-11-01). `factory`: intake of an issue or thread, the factory opens the
 * PR. `adopted`: a pull request a person opened, taken in at REVIEW; its source is that pull request.
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
  /** The project key, `github:<host>:<repo node id>` (design 2026-11-01). Never shown: show its label. */
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
  /** URL of the posted spec comment, set with READY + spec_pending. Null before it, and on older items. */
  spec_comment_url: string | null;
  /**
   * URL of the last failure comment, set by the transition that blocks on a failed run. Null when that
   * comment was withheld by the egress scan or never posted, and on older items.
   */
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
 * last_head_sha, parent_id, phase, version and timestamps are store-owned.
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

/**
 * `update` runs no agent: the worker merges the base branch into a factory PR branch (design §5).
 * `resolve` is the agent run a human starts with `/resolve` on a merge conflict (design §5).
 * `manual` is a record, not work: a person pushed to the item's PR branch (design 2026-11-01). It is written
 * already succeeded and acknowledged, so no worker claims it and the controller applies nothing from it.
 * `interactive`: a person's own LLM session (`factory session`, design §5, 2026-11-01), written running with a lease,
 * never queued or claimed. It ends by `session finish` (succeeded), `session abandon` or a lost lease (failed).
 * `improve` runs no agent and calls no model (design §7): it groups the failed runs of a time window into one
 * stored report. It belongs to its project's system work item, queued daily and by `factory improve`.
 */
export type RunKind = "triage" | "implement" | "review" | "update" | "resolve" | "manual" | "interactive" | "improve";

/**
 * What the controller hands a run beyond the work item. `notes`: a human's `/resolve` text, untrusted. `wip`: the
 * failed implement run's commits on the forge; the retry pushes them with no agent run (design §5 Restarts).
 */
export interface RunInput {
  notes?: string;
  wip?: WipRef;
  /** An interactive run's record (design §5, 2026-11-01), kept here so no schema step is needed. Read via the Run fields. */
  session?: SessionRecord;
  /** An improve run's report window (design §7), fixed at enqueue so a retry reports the same runs. */
  improve?: ImproveWindow;
}

/** The finished runs an improve report covers: finished_at in [window_start, window_end). */
export interface ImproveWindow {
  window_start: Timestamp;
  window_end: Timestamp;
}

/**
 * Failed runs that share an error code and a normalized detail (design §7). `detail` is the normalized text,
 * never the raw detail. Run IDs in finish order; item IDs distinct, in the order their first run finished.
 */
export interface FailureGroup {
  error_code: string;
  detail: string;
  run_ids: RunId[];
  work_item_ids: WorkItemId[];
}

export type ImproveReportId = Brand<string, "ImproveReportId">;

/**
 * One improve run's report (design §7): `groups` hold two or more runs, `patterns` exactly one. Both sorted the
 * same way every time, so the same failed runs give the same report. One row per run.
 */
export interface ImproveReport extends ImproveWindow {
  id: ImproveReportId;
  run_id: RunId;
  project: string;
  groups: FailureGroup[];
  patterns: FailureGroup[];
  created_at: Timestamp;
}

/** Standing approvals (design 05-standing-approvals): the gate a human decision is made at. Only the spec gate so far. */
export type StandingGate = "spec";
/** What the spec at the gate is: a phase of a split, a split into phases, or a single spec. */
export type SpecKind = "phase" | "split" | "single";
/** A human's decision at a gate. */
export type GateOutcome = "approved" | "rejected" | "revised";

/** A standing-approval rule, one per (gate, tier). Stored only: nothing acts on it yet. `set_by`: a user ID. */
export interface StandingRule {
  gate: StandingGate;
  tier: Tier;
  enabled: boolean;
  set_by: UserId;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type StandingProposalId = Brand<string, "StandingProposalId">;

/** A proposal to turn a rule on, one per (gate, tier, run_length): the run that reached `threshold`. */
export interface StandingProposal {
  id: StandingProposalId;
  gate: StandingGate;
  tier: Tier;
  run_length: number;
  threshold: number;
  created_at: Timestamp;
}

/** An interactive run's scanned notes and last finish. Its person, transcript URL and token total are run columns. */
export interface SessionRecord { notes: SessionNote[]; last_finish: SessionFinish | null }
export interface SessionNote { at: Timestamp; text: string }
/** One `session finish` attempt: passed and pushed (`ok`), or the reasons it was refused. */
export interface SessionFinish { at: Timestamp; ok: boolean; reasons: string[]; pr_number: number | null }

/**
 * An implement run's commits kept on the forge after its push or PR failed (design §5 Restarts), on `branch`
 * (under the branch prefix) at `head`. The rest is what the retry needs instead of the agent's answer: the commit
 * count, the summary for the PR body, the next steps for any new handoff row, and the files the base merge
 * conflicted in, which the scope gate lets through. Agent text, egress-scanned with the outcome.
 */
export interface WipRef {
  branch: string;
  head: string;
  commits: number;
  summary: string;
  next_steps: string;
  conflicts: string[];
  /** The implementer's missing work and differences from the spec, for the retry's PR body. Absent on older rows. */
  missing?: string[];
  deviations?: string[];
}

/**
 * What a paused run left behind for the run that resumes it (design §5 Pause). Written by the worker that paused
 * it, from trusted git calls after the agent stopped; read only by the worker that claims it next.
 */
export interface RunResume {
  /** The host part of the pausing worker's id (`<host>:<pid>:<n>`). Only a worker on this host reattaches. */
  host: string;
  /** The sandbox id of the run folder, kept on that host until the run ends. */
  folder: string;
  /** The trusted base the folder was created against (its handle's `base_sha`), when the sandbox reported one. */
  base_sha: string | null;
  /** Implement only: HEAD before the agent's first step, the start of the run's own commits. */
  start_sha: string | null;
  /** Implement only: HEAD after the WIP commit, the commit a cross-host resume restores. */
  head: string | null;
  /** Implement only: the shared-storage key of the git bundle of start_sha..head; null when nothing to keep. */
  bundle: string | null;
  /**
   * What the run's agent calls used before the pause, so the resumed run's outcome counts it once (design §6
   * Measurement). Absent: nothing used yet.
   */
  usage?: RunUsage;
}

/** A row of `worker_pauses` (design §5 Pause): one worker loop, or every loop when `worker_id` is `*`. */
export interface WorkerPause {
  worker_id: WorkerId | "*";
  paused_by: string;
  paused_at: Timestamp;
}

/**
 * Named rows of `claim_pauses` (design §5 Restarts). `rate_limit`: no claim of any kind. `forge_auth`: the forge
 * refused the factory's credentials (401/403), so no implement-type claim (implement, update). `preflight_access`:
the push_access or pr_api preflight check failed another way (issue #216), so no implement-type claim either.
 * `github_rate_limit`: GitHub's REST rate limit was hit (2026-11-07), so no implement, update or review claim and no
 * GitHub poll until the reset its row holds; triage and resolve still claim.
 * `model_stall`: a run stalled (the model printed nothing for `stall_ms`), so no claim of any kind until a probe
 * gets an answer. Its row holds the next probe time, and unlike the others it stays in effect past that time:
 * it ends only when `model_answered` (the last answered probe, written with `pauseClaims(now, "model_answered")`)
 * is not before it. `getClaimPause("model_stall")` returns the next probe time while the pause is in effect, also
 * once it has passed (a probe is due); `getClaimPause("model_stall_since")` returns when the pause began (written
 * by the store when `pauseClaims(…, "model_stall")` starts one). `pauseClaims` returns `started` for it.
 */
export type ClaimPauseName =
  | "rate_limit" | "forge_auth" | "preflight_access" | "github_rate_limit" | "model_stall" | "model_stall_since" | "model_answered";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * How one claim of a run ended (design §6, run attempts). `running` while the claim holds the lease; then
 * `succeeded` / `failed` (completeRun), `paused` (pauseRun), `cancelled` (a close that stops running runs) or
 * `lease_expired` (the reaper). Not a run status: the run's own status values are unchanged.
 */
export type RunAttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "paused" | "lease_expired";

/**
 * One claim of a run (design §6): one record per claimRun, the claim that resumes a paused run included.
 * `attempt` counts the run's claims (1, 2, 3 …); it is not `Run.attempt`, which a resume does not raise.
 */
export interface RunAttempt {
  run_id: RunId;
  attempt: number;
  /** The claiming worker. Null only on records backfilled from a finished run, whose lease owner was cleared. */
  worker_id: WorkerId | null;
  status: RunAttemptStatus;
  /** Null only on backfilled records of runs from before `started_at` existed. */
  started_at: Timestamp | null;
  /** Null while `running`. */
  finished_at: Timestamp | null;
  /** The failed outcome's error code; `lease_expired` for a reaped claim; null otherwise. */
  error_code: string | null;
  /** failureClass() of a failed outcome; `infra` for a reaped claim; null for every other status. */
  failure_class: "task" | "infra" | "rate_limited" | "stalled" | "checks_env" | null;
  /** outcomeTokens() of the outcome that closed it; 0 when it closed without an outcome. */
  tokens: number;
}

/**
 * One host sleep a worker saw (design §5 Host sleep): one of its waits ended more than HOST_SLEEP_MS late.
 * Ids, a timestamp and a number only. Keyed by (worker_id, woke_at), so recording it again keeps one row.
 */
export interface HostSleep {
  worker_id: WorkerId;
  /** When the worker's late wait ended (the worker's clock). */
  woke_at: Timestamp;
  /** How late the wait ended: the time since the wait started minus the time it asked for. */
  gap_ms: number;
  /** The run the worker held when it woke; null for an idle tick. */
  run_id: RunId | null;
}

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
  /** Set at enqueue (e.g. the notes of a `/resolve`). Null when none was given, and on rows from before it existed. */
  input: RunInput | null;
  /**
   * Set while the run waits in `queued` after `workers pause` stopped it (design §5 Pause): no outcome, the lease
   * cleared, `attempt` unchanged. Cleared by the claim that resumes it. Null otherwise, and on older rows.
   */
  paused_at: Timestamp | null;
  /** The ID that asked for the pause (`--by`, default `system:cli`); set and cleared with paused_at. */
  paused_by: string | null;
  /**
   * The agent session of the run's main step when it was paused, for a same-host resume (`--resume`). Kept
   * after the resuming claim; null when the run was never paused.
   */
  session_id: string | null;
  /** Where a paused run's work is (folder, WIP commit, bundle), written by the pause; null when never paused. */
  resume: RunResume | null;
  /**
   * An interactive run's session record (design §5, 2026-11-01): the person's user ID (never a display name), the
   * transcript URL, the latest reported token total (added to token_cost once, when the run ends), the notes and the
   * last finish. Null (notes empty) on every other run and on older rows.
   */
  actor_id: UserId | null;
  transcript_url: string | null;
  session_tokens: number | null;
  session_notes: SessionNote[];
  last_finish: SessionFinish | null;
  created_at: Timestamp;
  /** Rewritten by every heartbeat; on a running run it is the time of the last heartbeat (or the claim). */
  updated_at: Timestamp;
}

/**
 * What a run's agent calls used (design §6 Measurement), summed over every call in the run. `cost_usd` is the
 * harness's own figure (not checked against the bill): the sum of the calls that reported one, null when none
 * did. `model`: the model the last reporting call named, null when none did.
 */
export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  model: string | null;
}

/** A run's full token count: input + output + cache read + cache write. */
export function usageTokens(u: RunUsage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;
}

/**
 * The tokens an outcome adds to its item's `token_cost`. Succeeded: `data.tokens` (the full count since
 * 2026-11-02; older rows keep the input + output count they stored). Failed: its `usage`, 0 when it has none
 * (rows from before it existed, reaper failures, cancelled runs).
 */
export function outcomeTokens(outcome: RunOutcome | null): number {
  if (!outcome) return 0;
  if (outcome.status === "succeeded") {
    const t = Number(outcome.data.tokens);
    return Number.isFinite(t) && t >= 0 ? t : 0;
  }
  return outcome.usage ? usageTokens(outcome.usage) : 0;
}

/** The tokens a finished run adds to token_cost: an interactive run's reported total, else `outcomeTokens`. */
export function runTokenCount(run: Pick<Run, "kind" | "outcome" | "session_tokens">): number {
  return run.kind === "interactive" ? (run.session_tokens ?? 0) : outcomeTokens(run.outcome);
}

/** The harness cost of an outcome in USD, or null when unknown (no usage stored, or the harness gave none). */
export function outcomeCost(outcome: RunOutcome | null): number | null {
  if (!outcome) return null;
  const u = outcome.status === "succeeded" ? (outcome.data.usage as Partial<RunUsage> | undefined) : outcome.usage;
  const c = u?.cost_usd;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

export type RunOutcome =
  /** `data.tokens`: the run's full token count; `data.usage`: its RunUsage (absent on older rows). */
  | { status: "succeeded"; summary: string; data: Record<string, unknown> }
  | {
      status: "failed";
      /** What the run's agent calls used before it failed. Absent on rows from before it existed. */
      usage?: RunUsage;
      /**
       * `rate_limited` means a usage or rate limit, `agent_stalled` a model that printed nothing for `stall_ms`;
       * neither is a failed attempt (design §5 Restarts).
       */
      error_code: string;
      detail: string;
      /** Infrastructure failure (lease loss, timeout, exception): counts toward `max_restart`, not `max_attempts`. */
      infra: boolean;
      /**
       * For `rate_limited`: when the limit resets, if the runner could tell. For `forge_auth`, `preflight_access` and
       * `github_rate_limited`: when the pause ends.
       */
      reset_at?: Timestamp | null;
      /** The last part of the run's output, for the last-attempt comment. Egress-scanned with the outcome. */
      output_tail?: string;
      /** A failed push or PR after the agent step: where its commits were kept; the retry resumes from it. */
      wip?: WipRef;
      /** For `forge_auth` and `preflight_access`: this run's failure started its claim pause (one owner comment per pause). */
      pause_started?: boolean;
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

export type VerdictId = Brand<string, "VerdictId">;
export type VerdictKind = "accept" | "changes" | "reject";
export type VerdictSeverity = "none" | "minor" | "major" | "critical";
/** Where the `/verdict` comment was written: the item's issue or its PR. */
export type VerdictTarget = "issue" | "pr";

/**
 * A human's structured verdict on a work item (`/verdict`, design §4). Linked to the state_changes row
 * (reason `human_verdict`) that carries the actor; changes no work-item field.
 */
export interface Verdict {
  id: VerdictId;
  work_item_id: WorkItemId;
  state_change_id: StateChangeId;
  verdict: VerdictKind;
  severity: VerdictSeverity;
  /** Null only for `accept` without a reason. */
  reason: string | null;
  /** The comment that held the command. Unique: a redelivered comment records nothing. */
  comment_id: string;
  target: VerdictTarget;
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

/**
 * A pull request that merged with no work item (design 2026-11-01): skipped with `factory: skip`, from a fork,
 * never adopted, or merged before the first poll. One row per (project, pr_number).
 */
export interface UnreviewedMerge {
  id: UnreviewedMergeId;
  /** The project key (design 2026-11-01), as on WorkItem. */
  project: string;
  pr_number: number;
  merge_sha: string;
  /** The merger's user ID; null when the forge did not name one or it did not resolve to a user. */
  merger_id: UserId | null;
  at: Timestamp;
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
