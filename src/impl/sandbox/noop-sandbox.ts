import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalMergeResult, LocalMergeSpec } from "../../core/local-merge.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../interfaces/sandbox.js";
import { baseEnv, type RunProcessOptions, runProcess } from "../process/run-process.js";

/** Runs one process; `runProcess` unless a test injects a fake. */
export type ProcessRunner = (cmd: readonly string[], opts: RunProcessOptions) => Promise<ExecResult>;
/** Waits `ms` before a retry; a real timer unless a test injects one. */
export type Wait = (ms: number) => Promise<void>;

/** Name of the empty hooks folder under the worktrees dir: beside the run folders, never inside one. */
export const EMPTY_HOOKS_DIR = ".empty-hooks";
/** The ids `create` makes; `reattach` takes no other, so a stored id can never name a path outside the worktrees dir. */
const SANDBOX_ID = /^sbx_[0-9a-f]{8}$/;
/** Git's messages when another fetch in the same checkout holds or moved a ref this one is updating. */
const REF_LOCK = /incorrect old value|cannot lock ref|unable to update local ref/;
/** Retries after the first attempt of a fetch that lost a ref-lock race. */
const REF_LOCK_RETRIES = 3;
/** A branch name fetchBranch takes: a plain ref path, never an option or a refspec. */
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const RETRY_BASE_MS = 200;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The tail of each factory checkout's fetch chain, by repo path. Process-wide, so every sandbox instance on this
 * host shares it; it only orders fetches and holds nothing another replica would need.
 */
const fetchChains = new Map<string, Promise<unknown>>();

/**
 * One clone of the factory repo per run, on the host. No isolation: the agent has the host user's access, so
 * the harness-level guards (G3 via Claude Code's OS sandbox, G4) carry the weight (design §5).
 *
 * Writes (design §5 Sandbox): an agent may write only under the run folder, the run's `writable_paths` and its
 * runner's temp folder, never the owner's live checkout, though run folders sit inside it. This class adds no
 * OS rule for that: the runner enforces it (Claude Code: `Edit(...)` allow rules for native Write and Edit, and
 * its OS sandbox's write list for Bash; other runners: the shared tools' guard policy), and the worker reports
 * any file that still appears in the live checkout during an agent step.
 *
 * The clone has its own git folder inside the run folder, so nothing the agent does to its index, HEAD, refs,
 * config or hooks reaches the owner's checkout or its `.git` (architecture §5). Objects are borrowed from the
 * factory repo through an alternates link, not copied. The clone's `core.hooksPath` is an empty, read-only
 * folder beside the run folders, so a hook file the agent plants in the clone's `.git/hooks` never runs.
 * `base_sha` is the factory repo's `origin/<base>`, resolved before any agent runs.
 *
 * `local` (no GitHub plugin selected; design 05-sources, Local startup): nothing fetches origin. The trusted base
 * is the factory repo's local `refs/heads/<base>`, and the clone's `refs/remotes/origin/*` are the factory repo's
 * local branches, so `origin/<base>` and `origin/<branch>` in a run folder name the local base and factory branches.
 */
export class NoOpSandbox implements Sandbox {
  constructor(
    private readonly worktreesDir: string,
    private readonly run: ProcessRunner = runProcess,
    private readonly wait: Wait = realWait,
    private readonly opts: { local?: boolean } = {},
  ) {}

  /** The factory repo's trusted base ref: `origin/<base>`, or the local branch when nothing fetches origin. */
  private baseRef(base: string): string {
    return this.opts.local ? `refs/heads/${base}` : `origin/${base}`;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `sbx_${randomUUID().slice(0, 8)}`;
    const workdir = join(this.worktreesDir, id);
    await mkdir(this.worktreesDir, { recursive: true });
    const hooks = await this.emptyHooks();

    // Trusted: the factory repo's own refs and config, never anything an agent wrote. All of origin/*, so an
    // existing factory/<id> branch can be resumed. Local: no fetch; the local branches are what a run resumes.
    if (!this.opts.local) await this.fetch(spec.repo, ["fetch", "--quiet", "--prune", "origin"]);
    const common = (await this.git(spec.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    const base_sha = (
      await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `${this.baseRef(spec.base_ref)}^{commit}`])
    ).stdout.trim();
    const url = this.opts.local ? null : await this.git(spec.repo, ["remote", "get-url", "origin"], false);

    try {
      // --template=: no sample hooks or other files copied from the host's template dir.
      await this.git(this.worktreesDir, ["init", "--quiet", "--template=", workdir]);
      await mkdir(join(workdir, ".git", "objects", "info"), { recursive: true });
      await writeFile(join(workdir, ".git", "objects", "info", "alternates"), `${join(common, "objects")}\n`);
      await this.git(workdir, ["config", "core.hooksPath", hooks]);
      // The clone's `origin` names the real remote, for the agent's own reading. Nothing trusted pushes to it:
      // the broker pushes to the factory repo's remote (design §5).
      if (url && url.exit_code === 0 && url.stdout.trim()) await this.git(workdir, ["remote", "add", "origin", url.stdout.trim()]);
      // Remote-tracking refs as the factory repo has them (local: its branches). Objects are already reachable via alternates.
      const refs = this.opts.local
        ? ["+refs/heads/*:refs/remotes/origin/*"]
        : ["+refs/remotes/origin/*:refs/remotes/origin/*", "^refs/remotes/origin/HEAD"];
      await this.git(workdir, ["fetch", "--quiet", "--no-tags", spec.repo, ...refs]);

      if (spec.branch === null) {
        await this.git(workdir, ["checkout", "--quiet", "--detach", base_sha]);
      } else {
        const remote = await this.git(workdir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${spec.branch}`], false);
        const start = remote.exit_code === 0 ? `origin/${spec.branch}` : `origin/${spec.base_ref}`;
        await this.git(workdir, ["checkout", "--quiet", "-B", spec.branch, start]);
      }
    } catch (err) {
      await rm(workdir, { recursive: true, force: true });
      throw err;
    }
    return { id, workdir, base_sha };
  }

  exec(handle: SandboxHandle, cmd: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    return runProcess(cmd, {
      cwd: opts.cwd ? join(handle.workdir, opts.cwd) : handle.workdir,
      env: opts.env,
      ...(opts.stdin !== undefined && { stdin: opts.stdin }),
      ...(opts.timeout_ms !== undefined && { timeout_ms: opts.timeout_ms }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.onStdout !== undefined && { onStdout: opts.onStdout }),
    });
  }

  async copyIn(handle: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    await cp(hostPath, join(handle.workdir, sandboxPath), { recursive: true });
  }

  async copyOut(handle: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void> {
    await cp(join(handle.workdir, sandboxPath), hostPath, { recursive: true });
  }

  /**
   * A paused run's folder on this host (design §5 Pause): only an id `create` could have made, whose clone (its
   * own `.git` folder) is still there. Anything else, a folder from another host included, is null.
   */
  async reattach(id: string): Promise<SandboxHandle | null> {
    if (!SANDBOX_ID.test(id)) return null;
    const workdir = join(this.worktreesDir, id);
    const git = await stat(join(workdir, ".git")).catch(() => null);
    return git?.isDirectory() ? { id, workdir } : null;
  }

  /** The clone is self-contained: removing its folder is the whole teardown. Nothing to undo in the factory repo. */
  async destroy(handle: SandboxHandle): Promise<void> {
    await rm(handle.workdir, { recursive: true, force: true });
  }

  /**
   * The empty hooks folder every clone's core.hooksPath names: read-only, outside every run folder. A file in
   * it means someone planted a hook there, so creation refuses rather than point a clone at it.
   */
  private async emptyHooks(): Promise<string> {
    const dir = join(this.worktreesDir, EMPTY_HOOKS_DIR);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555);
    const entries = await readdir(dir);
    if (entries.length > 0) throw new Error(`hooks folder ${dir} is not empty: ${entries.join(", ")}`);
    return dir;
  }

  /** Fetches only the base branch, so it touches no other ref in the shared checkout. Local: no fetch, the local base. */
  async updateBase(spec: Pick<SandboxSpec, "repo" | "base_ref">): Promise<string> {
    const ref = `refs/heads/${spec.base_ref}`;
    if (this.opts.local) return (await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
    return this.serialized(spec.repo, async () => {
      await this.fetchWithRetry(spec.repo, ["fetch", "--quiet", "--no-tags", "origin", `+${ref}:refs/remotes/origin/${spec.base_ref}`]);
      return (await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `origin/${spec.base_ref}^{commit}`])).stdout.trim();
    });
  }

  /** Fetches only `branch` (a factory PR branch), like updateBase; null when origin has no such branch. Local: the local branch. */
  async fetchBranch(spec: { repo: string; branch: string }): Promise<string | null> {
    if (!SAFE_BRANCH.test(spec.branch) || spec.branch.includes("..")) throw new Error(`refusing to fetch branch ${JSON.stringify(spec.branch)}`);
    if (this.opts.local) return this.localCommit(spec.repo, spec.branch);
    return this.serialized(spec.repo, async () => {
      const args = ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${spec.branch}:refs/remotes/origin/${spec.branch}`];
      const first = await this.git(spec.repo, args, false);
      if (first.exit_code !== 0) {
        if (/couldn't find remote ref/i.test(first.stderr)) return null;
        await this.fetchWithRetry(spec.repo, args);
      }
      return (await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `refs/remotes/origin/${spec.branch}^{commit}`])).stdout.trim();
    });
  }

  /**
   * `git merge-tree --write-tree` in the factory repo: it writes only objects (the merged tree), never HEAD, the
   * index, the working tree or a ref. Exit 0 is clean, 1 is conflicts (their paths follow the tree id).
   */
  async mergeCheck(spec: { repo: string; head_sha: string; base_sha: string }): Promise<{ mergeable: boolean; conflicts: string[] }> {
    for (const sha of [spec.head_sha, spec.base_sha]) {
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
    }
    const r = await this.mergeTree(spec.repo, spec.base_sha, spec.head_sha);
    return { mergeable: r.conflicts.length === 0, conflicts: r.conflicts };
  }

  /**
   * The local merge (design 05-sources, Local startup): `branch` into the local `base_ref` of the factory repo,
   * never in the owner's checkout. merge-tree writes the merged tree and commit-tree the merge commit, both only
   * objects; `checks` then run on that commit in a temporary detached worktree (hooks off), removed afterwards;
   * a failing one moves nothing. Only then `refs/heads/<base_ref>` moves conditionally on the base that was merged
   * (another merge in between is refused, nothing lost). No push, no hook: the owner's checkout keeps its HEAD and
   * status. A base branch checked out in any worktree is refused: moving it would change that checkout's status.
   */
  async mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> {
    for (const b of [spec.base_ref, spec.branch]) {
      if (!SAFE_BRANCH.test(b) || b.includes("..")) throw new Error(`refusing to merge branch ${JSON.stringify(b)}`);
    }
    const base = await this.localCommit(spec.repo, spec.base_ref);
    if (base === null) return { merged: false, refused: `the factory repo has no local branch \`${spec.base_ref}\`` };
    const head = await this.localCommit(spec.repo, spec.branch);
    if (head === null) return { merged: false, refused: `the factory repo has no local branch \`${spec.branch}\`` };
    const contained = await this.git(spec.repo, ["merge-base", "--is-ancestor", head, base], false);
    if (contained.exit_code === 0) return { merged: true, sha: base, already: true };
    const worktrees = (await this.git(spec.repo, ["worktree", "list", "--porcelain"])).stdout.split("\n\n");
    const holder = worktrees.find((w) => w.split("\n").includes(`branch refs/heads/${spec.base_ref}`));
    if (holder) {
      const path = holder.split("\n")[0]!.replace(/^worktree /, "");
      return {
        merged: false,
        refused: `\`${spec.base_ref}\` is checked out in ${path}, and moving it would change that checkout; switch it to another branch (\`git switch --detach\`) and run the merge again`,
      };
    }
    const tree = await this.mergeTree(spec.repo, base, head);
    if (tree.conflicts.length > 0) return { merged: false, conflicts: tree.conflicts };
    const who = spec.identity;
    const identity = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const sha = (await this.git(spec.repo, ["commit-tree", tree.tree, "-p", base, "-p", head, "-m", spec.message], true, identity)).stdout.trim();
    const failed = await this.checkMerge(spec, sha);
    if (failed) return { merged: false, refused: failed };
    const moved = await this.git(spec.repo, ["update-ref", "-m", spec.message.split("\n")[0]!, `refs/heads/${spec.base_ref}`, sha, base], false);
    if (moved.exit_code !== 0) return { merged: false, refused: `\`${spec.base_ref}\` moved during the merge; run it again` };
    return { merged: true, sha, already: false };
  }

  /**
   * Runs `spec.checks` in order on `sha` in a temporary detached worktree of the factory repo under the worktrees
   * dir, with the host's base env and no hook. Null when every one passed; otherwise why the merge stops. The
   * worktree is removed whatever the outcome.
   */
  private async checkMerge(spec: LocalMergeSpec, sha: string): Promise<string | null> {
    if (spec.checks.length === 0) return null;
    await mkdir(this.worktreesDir, { recursive: true });
    const dir = await mkdtemp(join(this.worktreesDir, ".merge-"));
    const hooks = await this.emptyHooks();
    try {
      await this.git(spec.repo, ["-c", `core.hooksPath=${hooks}`, "worktree", "add", "--quiet", "--detach", dir, sha]);
      for (const cmd of spec.checks) {
        const r = await this.run(cmd, { cwd: dir, env: baseEnv(), timeout_ms: spec.timeout_ms });
        if (r.exit_code !== 0) {
          return `\`${cmd.join(" ")}\` ${r.timed_out ? "timed out" : `exited ${r.exit_code}`} on the merged commit, so \`${spec.base_ref}\` did not move; fix it on the branch and run the merge again`;
        }
      }
      return null;
    } finally {
      await this.git(spec.repo, ["worktree", "remove", "--force", dir], false);
      await rm(dir, { recursive: true, force: true });
      await this.git(spec.repo, ["worktree", "prune"], false);
    }
  }

  /** The commit of the factory repo's local branch `branch`, or null when there is none. */
  private async localCommit(repo: string, branch: string): Promise<string | null> {
    const r = await this.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`], false);
    return r.exit_code === 0 ? r.stdout.trim() : null;
  }

  /**
   * `git merge-tree --write-tree` in the factory repo: only objects. Exit 0: clean, `tree` the merged tree. Exit 1:
   * the conflicting paths (after the tree id), each once, sorted. Anything else throws.
   */
  private async mergeTree(repo: string, base: string, head: string): Promise<{ tree: string; conflicts: string[] }> {
    const r = await this.git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, head], false);
    if (r.exit_code !== 0 && r.exit_code !== 1) throw gitError(["merge-tree"], r);
    const [tree = "", ...files] = r.stdout.split("\n").filter((l) => l.length > 0);
    return { tree, conflicts: r.exit_code === 0 ? [] : [...new Set(files)].sort() };
  }

  /** A fetch in the factory checkout: one at a time per repo path, a lost ref-lock race retried. */
  private fetch(repo: string, args: string[]): Promise<ExecResult> {
    return this.serialized(repo, () => this.fetchWithRetry(repo, args));
  }

  /** Runs `fn` after every earlier call for `repo` on this host has settled, whatever their outcome. */
  private serialized<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const key = resolve(repo);
    const next = (fetchChains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    fetchChains.set(key, tail);
    void tail.then(() => {
      if (fetchChains.get(key) === tail) fetchChains.delete(key);
    });
    return next;
  }

  /**
   * A fetch whose failure names a ref lock is retried up to REF_LOCK_RETRIES times: another git process on the
   * checkout (the owner's, or another host process) moved the ref under it. Any other failure throws at once.
   */
  private async fetchWithRetry(repo: string, args: string[]): Promise<ExecResult> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.git(repo, args, false);
      if (r.exit_code === 0) return r;
      if (attempt >= REF_LOCK_RETRIES || !REF_LOCK.test(r.stderr)) throw gitError(args, r);
      await this.wait(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  private async git(cwd: string, args: string[], check = true, env: Record<string, string> = {}): Promise<ExecResult> {
    const r = await this.run(["git", "-C", cwd, ...args], { cwd, env: baseEnv({ ...env, GIT_TERMINAL_PROMPT: "0" }) });
    if (check && r.exit_code !== 0) throw gitError(args, r);
    return r;
  }
}

function gitError(args: readonly string[], r: ExecResult): Error {
  return new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
}
