// design §5. Swapping implementations (NoOp → Docker → gVisor) never touches agents.

export interface SandboxSpec {
  /** Repository to check out (the factory repo). The run gets its own copy; this repo is never written by the run. */
  repo: string;
  /** Branch the run works on. null = detached checkout of base_ref (read-only roles). */
  branch: string | null;
  /** Base ref for a new branch, e.g. "main". Ignored if the branch already exists on the remote (resume). */
  base_ref: string;
  /** Per-worker resources (Phase 2): ports, test DB. */
  ports?: number[];
}

export interface SandboxHandle {
  readonly id: string;
  /**
   * Working directory inside the sandbox: the run folder. For NoOpSandbox, a host path of the run's own clone,
   * whose git folder is inside it. A sandbox never shares the owner's checkout or its `.git` with a run
   * (architecture §5): everything an agent may write is under this folder.
   */
  readonly workdir: string;
  /**
   * The source repo's `origin/<base_ref>` commit, resolved by the sandbox from the factory repo (not from the
   * run folder) before any agent runs. The worker's gates diff against it. Absent: the worker resolves
   * `origin/<base_ref>` in the run folder before the agent runs.
   */
  readonly base_sha?: string;
}

export interface ExecOptions {
  cwd?: string;
  /** The full environment. Nothing is inherited from the worker (G1). */
  env: Readonly<Record<string, string>>;
  timeout_ms?: number;
  stdin?: string;
  signal?: AbortSignal;
  /**
   * Called with each chunk of stdout as it arrives, before the command exits (design §5 Restarts, stall
   * detection). The full stdout is still in the result. Absent: output is only read at the end.
   */
  onStdout?: (chunk: string) => void;
}

export interface ExecResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface Sandbox {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /**
   * Trusted, as in create: fetches origin in the factory repo and returns its `origin/<base_ref>` commit. A run
   * that needs a newer base (sync before push) copies it from the factory repo, never from the clone's own
   * remote, whose config the agent could have changed.
   */
  updateBase(spec: Pick<SandboxSpec, "repo" | "base_ref">): Promise<string>;
  /**
   * Trusted, like updateBase: fetches only `branch` from origin into the factory repo's
   * `refs/remotes/origin/<branch>` and returns its commit; null when origin has no such branch. Touches no other
   * ref, and never the checkout's HEAD, index or working tree. Absent: the controller's merge check is off.
   */
  fetchBranch?(spec: { repo: string; branch: string }): Promise<string | null>;
  /**
   * Whether `head_sha` merges cleanly into `base_sha`, computed in the factory repo's object store without a
   * checkout (`git merge-tree --write-tree`), so the repo's HEAD, index and working tree stay as they are.
   * `conflicts`: the conflicting file paths, each once, sorted; empty when mergeable. Throws on a git error (an
   * unknown commit, no merge base). Absent: the controller's merge check is off (design §5 Merge check).
   */
  mergeCheck?(spec: { repo: string; head_sha: string; base_sha: string }): Promise<{ mergeable: boolean; conflicts: string[] }>;
  exec(handle: SandboxHandle, cmd: readonly string[], opts: ExecOptions): Promise<ExecResult>;
  copyIn(handle: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void>;
  copyOut(handle: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void>;
  /**
   * The run folder `id` (a handle's `id`) if it still exists on this host, for a paused run resumed here (design
   * §5 Pause); null when it is gone or was made on another host. The handle has no `base_sha`: the caller keeps
   * the one `create` reported. A folder lives from `create` until `destroy`, which the worker calls when the run
   * ends, whatever the outcome; a pause skips it. Absent: no reattach, a paused run always gets a new folder.
   */
  reattach?(id: string): Promise<SandboxHandle | null>;
  /** Idempotent. Safe on an already-destroyed handle. */
  destroy(handle: SandboxHandle): Promise<void>;
}
