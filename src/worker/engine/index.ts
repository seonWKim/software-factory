// The ExecutionEngine (RFC 0015 §6.2, §7 Workers): a run is a sequence of named steps, and a step's stored
// result wins over running it again. A worker that dies mid-run is detected by its lease, and another worker
// takes the run over and resumes after the last finished step. `journal` (plugins/journal/) is the default;
// Temporal and Restate implement the same contract later (tests/execution-engine-contract.test.ts).
//
// Time comes only from ticks (§5.3): the engine embeds the worker's TickGenerator and moves on its `heartbeat`
// (renew leases, time steps out) and `reaper` (take over expired runs, fail runs past their deadline) ticks.

import type { Tick, TickGenerator } from "../../shared/ticks/tick-generator.js";

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
  /** Lease length: a run whose worker has not renewed it for this long is taken over. */
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
   * Runs one step of a held run, or returns its stored result when an earlier attempt finished it. Results must
   * be JSON values. Rejects with StepTimeoutError, RunDeadlineError or LeaseLostError, or with `fn`'s error.
   */
  step<T>(run: RunRef, stepId: StepId, fn: (ctx: StepContext) => Promise<T>): Promise<T>;
  /** Finishes a held run. False when the lease was lost (another worker owns the run now). */
  complete(run: RunRef, result: RunResult): Promise<boolean>;
  /** Registers the `heartbeat` and `reaper` schedules on the worker's tick generator. */
  attach(ticks: TickGenerator, periods?: Partial<TickPeriods>): void;
  /** Renews this worker's leases and times out steps. The `heartbeat` tick; public for tests. */
  heartbeat(tick: Tick): Promise<void>;
  /** Fails runs past their deadline and takes over runs whose lease expired. The `reaper` tick; public for tests. */
  reap(tick: Tick): Promise<RunRef[]>;
}

export interface TickPeriods {
  readonly heartbeat: number;
  readonly reaper: number;
}

/** RFC 0015 §5.3 defaults. */
export const DEFAULT_TICK_PERIODS: TickPeriods = { heartbeat: 10_000, reaper: 30_000 };

/** Journal error codes, also the `error_code` of a failed step row and of a run failed by the reaper. */
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

/** This worker no longer holds the run: another worker took it over, or it was finished elsewhere. */
export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(readonly runId: string) {
    super(`lease on run ${runId} lost`);
  }
}
