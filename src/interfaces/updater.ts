// Keeps the running factory on the latest base-branch commit (design: "Self-update"). The supervisor of
// `dev` drives it; `none` runs in place, `git-worktree` runs each built version of origin/<base_branch> from its
// own folder, starting the new version before the old one drains (start-then-drain).

import type { ExecResult } from "./sandbox.js";

/**
 * Set by the supervisor for its child: the runtime copy that holds the code, factory.config.json and
 * prompts/. Explicit, never inferred. Unset: code and state share one root (today's behaviour).
 */
export const CODE_ROOT_ENV = "SOFTWARE_FACTORY_CODE_ROOT";
/**
 * The config file to load instead of the code root's factory.config.json, as `--config <path>` does. The
 * supervisor sets it, absolute, for each child and each migrate call, so an update keeps the same file.
 */
export const CONFIG_ENV = "FACTORY_CONFIG";
/**
 * Set by the supervisor for its child: the first worker index of the child's block. The child's worker pool
 * numbers its workers from it, so two children alive at once (old draining, new claiming) never share an index.
 * Unset: 0.
 */
export const WORKER_INDEX_BASE_ENV = "SF_WORKER_INDEX_BASE";
/**
 * Set by the supervisor for its child: the revision the child was built from. The child's workers stamp it on each
 * run they execute (`worker_runs.code_version`), so a run journaled by one revision is resumed only by code that
 * can resume it. Unset (an unsupervised `dev`): `dev`.
 */
export const CODE_VERSION_ENV = "SF_CODE_VERSION";
/** Set to "1" by the supervisor for its child, so `dev` runs controller + worker instead of supervising. */
export const SUPERVISED_ENV = "SOFTWARE_FACTORY_SUPERVISED";
/** IPC messages between the supervisor and its child. No new signal: SIGTERM stays the hard stop. */
export const DRAIN_MESSAGE = "factory:drain";
export const DRAINED_MESSAGE = "factory:drained";
/**
 * Sent by a child before it exits on an error, with `error`: the message it prints, and `code` when the error
 * has one (MIGRATION_PENDING: the store refused to open while schema or data steps are pending).
 */
export const CHILD_ERROR_MESSAGE = "factory:error";

/** The stable `code` of the error a store throws while `npm run migrate` has steps to apply. */
export const MIGRATION_PENDING = "migration_pending";

/** An Error carrying `code: MIGRATION_PENDING`, so the supervisor never has to match the message text. */
export function migrationPendingError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: MIGRATION_PENDING as string });
}

/**
 * `<state_dir>/supervisor-request.json`: what `npm run migrate` asks a running supervisor to do, read on its
 * next poll and then removed. drain: stop every child and start none. start: the steps applied; start the
 * waiting revision. cancel: the steps failed; start the old revision again.
 */
export const SUPERVISOR_REQUEST_FILE = "supervisor-request.json";
export interface SupervisorRequest {
  action: "drain" | "start" | "cancel";
  /** ISO time the request was written. */
  at: string;
}

/** Runs one host command. Same shape as `runProcess`, so tests can pass a fake. */
export type CommandRunner = (
  cmd: readonly string[],
  opts: { cwd: string; env: Readonly<Record<string, string>>; timeout_ms?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/** The `dev` child the supervisor starts: controller + worker from a code root. */
export interface ChildSpec {
  /** Script to run, e.g. `<runtime>/dist/main.js`. */
  entry: string;
  args: readonly string[];
  /** Working directory: the main checkout (the state root). */
  cwd: string;
  /** Added to the supervisor's environment for the child (CODE_ROOT_ENV, and CONFIG_ENV with an external config). */
  env: Readonly<Record<string, string>>;
}

export interface ChildHandle {
  readonly pid: number;
  /** Asks the child to stop claiming runs and exit once its in-flight run is done. Not a signal. */
  requestDrain(): void;
  /** True once the child said it drained (after its worker finished the in-flight run). */
  readonly drainAcknowledged: boolean;
  /** The error the child sent before exiting on an error, or null. */
  readonly lastError: string | null;
  /** That error's `code` (e.g. MIGRATION_PENDING), or null. */
  readonly lastErrorCode?: string | null;
  /** Resolves with the exit code (null if killed by a signal) when the child exits. */
  readonly exited: Promise<number | null>;
  /** SIGTERM: today's hard stop. SIGKILL: when it did not exit in time. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface ChildLauncher {
  launch(spec: ChildSpec): ChildHandle;
}

export interface Updater {
  /** `in-place`: the supervisor runs controller + worker itself, as before. `supervised`: it runs a child. */
  readonly mode: "in-place" | "supervised";
  /** Prepares the code root (first start: create, install, build) and starts the child. */
  start(): Promise<void>;
  /** Fetches the base branch. Returns the new commit to move to, or null if there is nothing to do. */
  check(): Promise<string | null>;
  /**
   * One supervision step: check for a new base commit, build it in its own folder while the running child
   * keeps claiming, and only if the build succeeded start the new child at once and ask the older ones to
   * drain. Never waits for an old child to exit. Restarts a crashed child from the last folder that built.
   */
  poll(): Promise<void>;
  /** PID of the newest (claiming) child, or null. */
  childPid(): number | null;
  /** PIDs of every live child: the claiming one and any still draining. Absent: at most childPid(). */
  childPids?(): number[];
  /** Stops every live child (SIGTERM, then SIGKILL after the drain timeout), waits for all, stops supervising. */
  shutdown(): Promise<void>;
}

/**
 * What the supervisor is doing, written to `<state_dir>/supervisor.json` on every change so the status page
 * can say why no new runs start (a drain) and when new code and settings take effect.
 */
export interface SupervisorStatus {
  /** running: the child claims work (older children may still be draining, see `draining_pids`). building: a
   * new revision builds in its own folder while the child keeps claiming. build_failed: the running child stays
   * on `rev`. crashed: the child exited without being asked to (it is restarted every poll); `error` says why.
   * stopped: no child. draining and restarting are no longer written by git-worktree (start-then-drain) but stay
   * valid values for readers of older files.
   * migration_pending: `target_rev` built but needs `npm run migrate` (`pending` names the steps); the child on
   * `rev` keeps claiming. migration_draining: a migration asked every child to drain; none claims. migration_ready:
   * no child is live; the steps may be applied, then the target starts. */
  state:
    | "running"
    | "building"
    | "draining"
    | "restarting"
    | "build_failed"
    | "crashed"
    | "stopped"
    | "migration_pending"
    | "migration_draining"
    | "migration_ready";
  /** The revision the child runs (null before the first start). */
  rev: string | null;
  /** The revision being built or started, when there is one. */
  target_rev: string | null;
  child_pid: number | null;
  /** Older children asked to drain that have not exited yet: they finish their in-flight runs, claim nothing. */
  draining_pids?: number[];
  /** ISO time this state began. A repeat of the same state keeps it. */
  since: string;
  /** crashed: the child's error, or its exit code when it sent none. */
  error?: string | null;
  /** migration_*: the pending step names the target revision reported (empty when it could not say). */
  pending?: string[];
  /** The supervisor's own pid, so `npm run migrate` can tell a live supervisor from a stale file. */
  supervisor_pid?: number;
  /**
   * The last RESTART_HISTORY unexpected child exits this supervisor restarts from, oldest first (design
   * 05-alarms: the alarm step counts them). Absent on files from before it existed and from the `none` updater.
   */
  restarts?: ChildRestart[];
}

/** One unexpected child exit: when (ISO time) and why (the child's error, else its exit code). */
export interface ChildRestart {
  at: string;
  reason: string;
}

/** Restarts the status file keeps. */
export const RESTART_HISTORY = 10;

export const SUPERVISOR_STATUS_FILE = "supervisor.json";
