// design §5. Swapping implementations (NoOp → Docker → gVisor) never touches agents.

export interface SandboxSpec {
  /** Repository to check out. */
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
  /** Working directory inside the sandbox. For NoOpSandbox, a host path of the git worktree. */
  readonly workdir: string;
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
