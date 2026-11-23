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
  /**
   * Trusted, from objects only (no checkout, no fetch): the text of `path` in the factory repo's local branch `ref`,
   * with that branch's commit; null when the branch or the file is missing. Absent: the file-only key writer is off
   * (design 08-settings).
   */
  readLocalFile?(spec: { repo: string; ref: string; path: string }): Promise<{ commit: string; text: string } | null>;
  /**
   * Trusted, from objects only (no checkout, no fetch): every file path under the folder `path` (ending in `/`) in
   * the factory repo's local branch `ref`, repo-relative; null when the branch is missing. Absent: triage's
   * migration timestamp check is off (triage, src/core/migration-stamps.ts).
   */
  listLocalFiles?(spec: { repo: string; ref: string; path: string }): Promise<string[] | null>;
  /**
   * Trusted, from objects only (no checkout, no fetch, no ref written): the factory repo's trusted base (`origin/<base_ref>`,
   * or the local branch when nothing fetches origin) with its committer time, and, given `head_sha`, what that head changes
   * against it as `git diff <base>...<head>` lists it: each file with its added and removed line counts, and, given `path`
   * too, that file's patch cut to `max_bytes`. The dashboard's Changes tab and Re-check read it (design 09-dashboard-item).
   * `base` null: the repo has no such base. Throws on a git error (an unknown head, no merge base). Absent: no Changes tab.
   */
  readChanges?(spec: ChangesSpec): Promise<ChangesRead>;
  /**
   * Trusted: one commit on a new local branch without a checkout (design 08-settings, the file-only key writer).
   * The commit's parent is `parent`, the local `base_ref`'s commit, and its tree is the parent's with only `path`
   * set to `content`. `refs/heads/<branch>` is then created by a conditional ref update that fails when it exists.
   * Only objects and that one ref are written: the repo's HEAD, index, working tree and every other ref stay as
   * they are. `exists`: the branch was there; `base_moved`: the base is no longer at `parent`; nothing moved.
   */
  commitNewBranch?(spec: NewBranchCommit): Promise<NewBranchResult>;
  /**
   * Trusted, for a base reconcile (design 05-sources, Base reconcile): fetches only origin's `base_ref` into the
   * factory repo's `refs/remotes/origin/<base_ref>`, also on the local route, and creates the local branch `branch` at
   * the local `base_ref` when it is missing, so the reconcile branch starts from local main, never from origin. An
   * existing branch is kept (a retry resumes it). Throws on a failed fetch or a missing local base. Absent: no reconcile.
   */
  startReconcile?(spec: ReconcileSpec): Promise<ReconcileStart>;
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

export interface ChangesSpec {
  repo: string;
  base_ref: string;
  /** The head to list the changes of; absent: only the base is read. */
  head_sha?: string;
  /** One changed file to read the patch of (needs `head_sha`). */
  path?: string;
  /** The patch's limit in bytes; a longer patch is cut there and marked `truncated`. */
  max_bytes?: number;
}

/** One changed file: its path and line counts; both counts null for a binary file. */
export interface ChangedFile {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface ChangesRead {
  /** The trusted base's commit and its committer time (ISO 8601); null when the repo has no such base. */
  base: { sha: string; committed_at: string } | null;
  /** The changed files in path order; empty without `head_sha`. */
  files: ChangedFile[];
  /** The file's patch; null without `path`. */
  patch: { text: string; truncated: boolean } | null;
}

export interface NewBranchCommit {
  repo: string;
  base_ref: string;
  /** The base's commit the content was made from: a base at another commit moves nothing. */
  parent: string;
  branch: string;
  /** Path of the one file the commit changes, relative to the repo root. */
  path: string;
  content: string;
  message: string;
  /** The commit's author and committer: the factory's git identity, never a person's display name. */
  identity: { name: string; email: string };
}

export interface ReconcileSpec {
  repo: string;
  base_ref: string;
  /** The reconcile item's local branch. */
  branch: string;
}

/** The local source id of the one reconcile item for origin's `base_ref` at `remote`: a second conflict on that sha files none. */
export function reconcileSourceId(base_ref: string, remote: string): string {
  return `base-reconcile:${base_ref}:${remote}`;
}

/** The base and origin commit a reconcile item merges (from its local source id), or null for any other item. */
export function reconcileOf(it: { source: { type: string; id: string } }): { base_ref: string; remote: string } | null {
  const m = it.source.type === "local" ? /^base-reconcile:(.+):([0-9a-f]{40,64})$/.exec(it.source.id) : null;
  return m ? { base_ref: m[1]!, remote: m[2]! } : null;
}

/** `origin`: origin's base commit as fetched; `start`: the reconcile branch's commit (the local base when it was made). */
export interface ReconcileStart {
  origin: string;
  start: string;
}

export type NewBranchResult ={ created: true; sha: string } | { created: false; reason: "exists" | "base_moved" };
