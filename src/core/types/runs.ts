// Runs, their attempts, leases, usage and outcomes (split from src/core/types.ts). No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

import type { HandoffId, RunId, Timestamp, UserId, WorkItemId, WorkerId } from "./ids.js";
import type { ImproveWindow } from "./improve.js";

/**
 * `update` runs no agent: the worker merges the base branch into a factory PR branch (design §5). `resolve` is the agent
 * run a human starts with `/resolve` on a merge conflict (design §5). `screenshot` runs no agent (design 04-screenshots).
 * `manual` is a record, not work: a person pushed to the item's PR branch (design 2026-11-01). It is written already succeeded and acknowledged, so
 * no worker claims it and the controller applies nothing from it. `judge`: one read-only run per merged goal phase, on its goal split's parent (04-split-specs).
 * `interactive`: a person's own LLM session (`factory session`, design §5, 2026-11-01), written running with a lease,
 * never queued or claimed. It ends by `session finish` (succeeded), `session abandon` or a lost lease (failed).
 * `improve` runs no agent (design §7): it groups the failed runs of a time window into one stored report, with one plain model call (no tools)
 * per group of two or more runs for a draft cause and fix. It belongs to its project's system work item, queued daily and by `factory improve`.
 */
export type RunKind = "triage" | "implement" | "review" | "update" | "resolve" | "manual" | "interactive" | "improve" | "merge-check" | "restart" | "screenshot" | "judge" | "routine";

/**
 * What the controller hands a run beyond the work item. `notes`: a human's `/resolve` text, or the newest note a `rereview` runs for, untrusted. `wip`: where the last implement run kept its commits (keptWip); the retry pushes them with no agent run, or runs the agent on them when marked `continue` (design §5 Restarts).
 */
export interface RunInput {
  notes?: string;
  wip?: WipRef;
  /** An interactive run's record (design §5, 2026-11-01), kept here so no schema step is needed. Read via the Run fields. */
  session?: SessionRecord;
  /** An improve run's report window (design §7), fixed at enqueue so a retry reports the same runs. */ improve?: ImproveWindow;
  /** A review run's CI results (design §4, issue #223) read when it was queued: empty, none ran; null, the read failed; absent, not read. */
  ci_checks?: PrCheckResult[] | null;
  /** A review queued because a note or spec came after the last `bug` verdict at an unchanged head: it reviews that head again (design 05-ci-gate, 2026-11-23). */ rereview?: true;
  /** An implement run's failing tests from the failed CI job's log after its one rerun (design 05-ci-gate), redacted, untrusted. */
  ci_failing_tests?: string;
  merge_check?: { base_ref: string; branches: string[] }; // a merge-check run's base and the branches merged onto it in queue order, this change last (RFC 0015 M8)
  /** A judge run's goal lines, merged phase and recorded phases' titles (design 04-split-specs), fixed at enqueue so a retry judges the same. */ judge?: { phase: number; goal_done_when: string[]; title: string; problem: string; done_criteria: string[]; merge_sha: string; phases: string[] };
  routine?: { instruction: string; url: string | null }; // a `routine` run (read-only: Read, Glob, Grep, Browse): the owner's instruction and the one URL Browse may GET, fixed at enqueue
  /** A screenshot run's passing review; a screenshot review's flag, its screenshot run and what that run stored (design 04-screenshots). */ review_run_id?: string; screenshot_review?: true; screenshot_run_id?: string; screenshots?: { captures: { page: string; width: number; theme: string; key: string }[]; reason: string | null };
}

/** One check on a PR's head commit and its result. The name is forge text: untrusted (G5). */
export interface PrCheckResult {
  name: string;
  result: "passed" | "failed" | "pending";
  /** A failed check that was cancelled or timed out (design 05-ci-gate, Cancelled checks): not a code failure. */
  cancelled?: true;
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
 * `github_rate_limit`: the forge's REST rate limit was hit (2026-11-07), so no implement, update or review claim and no
 * forge poll until the reset its row holds; triage and resolve still claim.
 * `model_stall`: a run stalled (the model printed nothing for `stall_ms`), so no claim of any kind until a probe
 * gets an answer. Its row holds the next probe time, and unlike the others it stays in effect past that time:
 * it ends only when `model_answered` (the last answered probe, written by `endClaimPause("model_stall")`) is not
 * before it. `getClaimPause("model_stall")` returns the next probe time while the pause is in effect, also
 * once it has passed (a probe is due); `getClaimPause("model_stall_since")` returns when the pause began (written
 * by the store when `pauseClaims(…, "model_stall")` starts one). `pauseClaims` returns `started` for it.
 * `network`: a git call, push, preflight or model request could not reach its host, so no claim of any kind until
 * a network probe passes. A probe pause like `model_stall`, with `network_since` and `network_answered`. `model_credential`: no model credential, so no agent run is claimed (policy MODEL_CREDENTIAL).
 */
export type ClaimPauseName =
  | "rate_limit" | "forge_auth" | "preflight_access" | "github_rate_limit"
  | "model_stall" | "model_stall_since" | "model_answered"
  | "network" | "network_since" | "network_answered" | "model_credential";
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
  /** failureClass() of a failed outcome; `infra` for a reaped claim; null otherwise. `stalled`: rows before 2026-11-23. */
  failure_class: "task" | "infra" | "rate_limited" | "stalled" | "checks_env" | "setup_missing" | null;
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
  /** Who asked for the pause (the CLI identity's user of `factory workers pause`, or `system:network`); set and cleared with paused_at. */
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
      /** `rate_limited`: a usage or rate limit; `agent_stalled`: a model that printed nothing for `stall_ms`. Neither is a failed attempt (design §5 Restarts). */
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
      /** Where the run's commits were kept (a failed push or PR, a stop mid-work, any failure after commits); the retry resumes from it. */
      wip?: WipRef;
      /** For `forge_auth` and `preflight_access`: this run's failure started its claim pause (one owner comment per pause). */
      pause_started?: boolean;
      conflicts?: string[]; // a merge_conflict or resolve failure: the files the merge conflicted in (the improver's hotspot count reads only this)
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
