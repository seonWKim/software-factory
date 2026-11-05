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
 * Set by the supervisor for its child: the first worker index of the child's block. The child's worker pool
 * numbers its workers from it, so two children alive at once (old draining, new claiming) never share an index.
 * Unset: 0.
 */
export const WORKER_INDEX_BASE_ENV = "SF_WORKER_INDEX_BASE";
/** Set to "1" by the supervisor for its child, so `dev` runs controller + worker instead of supervising. */
export const SUPERVISED_ENV = "SOFTWARE_FACTORY_SUPERVISED";
/** IPC messages between the supervisor and its child. No new signal: SIGTERM stays the hard stop. */
export const DRAIN_MESSAGE = "factory:drain";
export const DRAINED_MESSAGE = "factory:drained";
/**
 * Sent by a child before it exits on an error, with `error`: the message it prints. A child that exits because
 * migration steps are pending also sends `code: MIGRATION_PENDING_CODE` and `pending`: the step names.
 */
export const CHILD_ERROR_MESSAGE = "factory:error";
/** The stable `code` of a child's start error when schema or data steps are pending. Never matched as text. */
export const MIGRATION_PENDING_CODE = "migration_pending";

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
  /** Added to the supervisor's environment for the child. */
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
  /** The `code` the child sent with its error (MIGRATION_PENDING_CODE), or null/absent. */
  readonly lastErrorCode?: string | null;
  /** With MIGRATION_PENDING_CODE: the pending step names the child sent. */
  readonly lastErrorPending?: readonly string[];
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
   * stopped: no child. migration_pending: `target_rev` built, but its migration check lists pending steps
   * (`pending_steps`), so it is not started and nothing drains; the child keeps running `rev` (none when the child
   * itself exited on pending steps). draining: written while `npm run migrate` holds the supervisor (`held`); the
   * old start-then-drain never writes it. restarting is no longer written but stays valid for older files. */
  state: "running" | "building" | "draining" | "restarting" | "build_failed" | "crashed" | "migration_pending" | "stopped";
  /** The revision the child runs (null before the first start). */
  rev: string | null;
  /** The revision being built or started, when there is one. */
  target_rev: string | null;
  child_pid: number | null;
  /** Older children asked to drain that have not exited yet: they finish their in-flight runs, claim nothing. */
  draining_pids?: number[];
  /** ISO time this state began. A repeat of the same state keeps it. */
  since: string;
  /** crashed: the child's error, or its exit code when it sent none. migration_pending: why the check failed. */
  error?: string | null;
  /** migration_pending (and a held drain): the step names the target's check listed. */
  pending_steps?: string[];
  /** The folder of the waiting target: `npm run migrate` runs that folder's migrate. */
  target_dir?: string | null;
  /** The supervisor's own pid: `npm run migrate` asks it to drain only while this pid is alive. */
  supervisor_pid?: number | null;
  /** True while a drain request from `npm run migrate` holds the supervisor: no child is started. */
  held?: boolean;
}

export const SUPERVISOR_STATUS_FILE = "supervisor.json";

/**
 * `<state_dir>/supervisor-request.json`, written by `npm run migrate` and read by the supervisor on its poll.
 * drain: stop every child and start none while the request stands (the migrate applies the steps meanwhile).
 * start: the steps applied; start the waiting target (or the newest folder when none waits). cancel: they
 * failed or the wait gave up; restart the old revision from its own folder. A drain whose `pid` is no longer
 * alive counts as cancel. The supervisor removes start and cancel once handled.
 */
export const SUPERVISOR_REQUEST_FILE = "supervisor-request.json";

export interface SupervisorRequest {
  action: "drain" | "start" | "cancel";
  /** The target revision the migrate applies steps for; null when none was waiting. */
  target_rev: string | null;
  /** The pid of the `npm run migrate` process. */
  pid: number;
  /** ISO time written. */
  at: string;
}
