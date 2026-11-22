// A running run's last model output time (design 05-restarts, decision of 2026-11-20): the store's
// `worker_runs.last_output_at`, never in-process state. The stall rule that reads it (`stallIsGlobal`) is in policy.ts.

import type { RunId, Timestamp } from "./types.js";

/** A running run's last model output time, written by the worker that holds its lease and read by the controller. */
export interface RunOutputStore {
  /** Stores now as the run's last model output time while it is `running` with `token`; false otherwise. Never the heartbeat's. */
  recordRunOutput(runId: RunId, token: number): Promise<boolean>;
  /** The latest last model output time of any `running` run, or null when none got output. */
  latestRunningOutput(): Promise<Timestamp | null>;
}
