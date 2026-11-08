// The ExecutionEngine (RFC 0015 §6.2, §7 Workers): a run is a sequence of named steps, and a step's stored
// result wins over running it again. A worker that dies mid-run is detected by its lease, and another worker
// takes the run over and resumes after the last finished step. `journal` (plugins/journal/) is the default;
// Temporal and Restate implement the same contract later (tests/execution-engine-contract.test.ts).
//
// Time comes only from ticks (§5.3): the engine moves on the ticks its worker hands it, the claim's and each
// `heartbeat` (renew leases, time steps out, abort a run past its deadline). It never takes a run over itself:
// the controller's reaper requeues a run whose lease expired, and the next claim resumes it from the journal
// (design 10-event-driven, "Runs execute as journaled steps").

import type { Tick } from "../../shared/ticks/tick-generator.js";

/** A step's name within its run kind: prepare-branch, run-agent, pre-push-checks, store-artifacts, ... */
export type StepId = string;

/** A run this engine holds: the lease token fences every write, so a worker whose lease was taken loses its writes. */
export interface RunRef {
  readonly id: string;
  readonly kind: string;
  readonly attempt: number;
  readonly lease_token: number;
}

/** Named timeouts of a run kind (RFC 0016 S7), in milliseconds. */
export interface RunTimeouts {
  /** Longest one attempt of one step may take; a step over it fails with `start_to_close`. */
  readonly start_to_close_ms: number;
  /** Lease length: a run whose worker has not renewed it for this long is requeued by the controller's reaper. */
  readonly heartbeat_ms: number;
  /** Longest a run may take from its creation over all attempts: `worker_runs.deadline_at`. */
  readonly schedule_to_close_ms: number;
  /** Per-step overrides of `start_to_close_ms`. */
  readonly steps?: Readonly<Record<StepId, { readonly start_to_close_ms: number }>>;
}

export interface StepContext {
  /** Aborts when the step times out, the run passes its deadline, or the lease is lost. */
  readonly signal: AbortSignal;
  /** The run attempt executing the step. */
  readonly attempt: number;
  /** What an interrupted earlier attempt of this step saved with `savePartial` (e.g. an agent session id), or null. */
  readonly partial: unknown;
  /** Journals progress of an unfinished step, so the attempt that resumes it can continue from there. */
  savePartial(value: unknown): Promise<void>;
}

export interface RunResult {
  readonly status: "succeeded" | "failed";
  readonly error_code?: string;
  readonly detail?: string;
}

export interface ExecutionEngine {
  /** Claims a queued run for this worker. Null when another worker has it, it is not due, or its code can't resume it. */
  claim(runId: string): Promise<RunRef | null>;
  /**
   * Holds a run another claim path already leased to this worker under `run.lease_token` (the legacy store's
   * claimRun, until runs arrive as RunRequested), stamping code_version and deadline_at as `claim` does. `now` is
   * the claiming tick. False when the lease is not that token's, or the run was journaled by code this worker
   * cannot resume.
   */
  adopt(run: RunRef, now: Tick): Promise<boolean>;
  /** Forgets a held run whose end another path stored (the legacy store's completeRun or pauseRun). */
  release(run: RunRef): void;
  /**
   * Runs one step of a held run, or returns its stored result when an earlier attempt finished it. Results must
   * be JSON values. Rejects with StepTimeoutError, RunDeadlineError or LeaseLostError, or with `fn`'s error.
   */
  step<T>(run: RunRef, stepId: StepId, fn: (ctx: StepContext) => Promise<T>): Promise<T>;
  /** Finishes a held run. False when the lease was lost (another worker owns the run now). */
  complete(run: RunRef, result: RunResult): Promise<boolean>;
  /** Renews this worker's leases, times out steps and aborts runs past their deadline. The worker's `heartbeat` tick. */
  heartbeat(tick: Tick): Promise<void>;
}

/** What a worker gives its engine: who it is, the code it runs, its run kinds, and how it hears of a lost run. */
export interface EngineOptions {
  /** This worker's id, stored as the lease owner. */
  readonly workerId: string;
  /** The revision this process runs (`worker_runs.code_version`). */
  readonly codeVersion: string;
  /** The run kinds this worker executes, with their named timeouts. */
  readonly kinds: Readonly<Record<string, RunTimeouts>>;
  /** Lease length at each renewal; default: the kind's `heartbeat_ms`. */
  readonly leaseMs?: (run: RunRef) => number;
  /** Called when the worker loses a held run (requeued, finished elsewhere, or past its deadline). */
  readonly onLost?: (run: RunRef, reason: Error) => void;
}

/** The `engine` plugin (`plugins.engine`, default `journal`): one ExecutionEngine per worker loop. */
export interface ExecutionEngines {
  create(o: EngineOptions): ExecutionEngine;
}

/** Journal error codes, also the `error_code` of a failed step row and of the run the worker fails with it. */
export const STEP_TIMEOUT = "start_to_close";
export const RUN_DEADLINE = "schedule_to_close";

export class StepTimeoutError extends Error {
  readonly code = STEP_TIMEOUT;
  constructor(readonly stepId: StepId, readonly timeoutMs: number) {
    super(`step ${stepId} ran past its start_to_close timeout (${timeoutMs} ms)`);
  }
}

export class RunDeadlineError extends Error {
  readonly code = RUN_DEADLINE;
  constructor(readonly runId: string, readonly deadline: string) {
    super(`run ${runId} passed its schedule_to_close deadline ${deadline}`);
  }
}

/** This worker no longer holds the run: it was requeued or claimed again, or finished elsewhere. */
export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(readonly runId: string) {
    super(`lease on run ${runId} lost`);
  }
}
