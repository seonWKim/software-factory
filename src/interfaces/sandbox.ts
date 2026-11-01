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
  exec(handle: SandboxHandle, cmd: readonly string[], opts: ExecOptions): Promise<ExecResult>;
  copyIn(handle: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void>;
  copyOut(handle: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void>;
  /** Idempotent. Safe on an already-destroyed handle. */
  destroy(handle: SandboxHandle): Promise<void>;
}
