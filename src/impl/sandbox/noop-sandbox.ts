import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
 * The clone has its own git folder inside the run folder, so nothing the agent does to its index, HEAD, refs,
 * config or hooks reaches the owner's checkout or its `.git` (architecture §5). Objects are borrowed from the
 * factory repo through an alternates link, not copied. The clone's `core.hooksPath` is an empty, read-only
 * folder beside the run folders, so a hook file the agent plants in the clone's `.git/hooks` never runs.
 * `base_sha` is the factory repo's `origin/<base>`, resolved before any agent runs.
 */
export class NoOpSandbox implements Sandbox {
  constructor(
    private readonly worktreesDir: string,
    private readonly run: ProcessRunner = runProcess,
    private readonly wait: Wait = realWait,
  ) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `sbx_${randomUUID().slice(0, 8)}`;
    const workdir = join(this.worktreesDir, id);
    await mkdir(this.worktreesDir, { recursive: true });
    const hooks = await this.emptyHooks();

    // Trusted: the factory repo's own refs and config, never anything an agent wrote. All of origin/*, so an
    // existing factory/<id> branch can be resumed.
    await this.fetch(spec.repo, ["fetch", "--quiet", "--prune", "origin"]);
    const common = (await this.git(spec.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    const base_sha = (
      await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `origin/${spec.base_ref}^{commit}`])
    ).stdout.trim();
    const url = await this.git(spec.repo, ["remote", "get-url", "origin"], false);

    try {
      // --template=: no sample hooks or other files copied from the host's template dir.
      await this.git(this.worktreesDir, ["init", "--quiet", "--template=", workdir]);
      await mkdir(join(workdir, ".git", "objects", "info"), { recursive: true });
      await writeFile(join(workdir, ".git", "objects", "info", "alternates"), `${join(common, "objects")}\n`);
      await this.git(workdir, ["config", "core.hooksPath", hooks]);
      // The clone's `origin` names the real remote, for the agent's own reading. Nothing trusted pushes to it:
      // the broker pushes to the factory repo's remote (design §5).
      if (url.exit_code === 0 && url.stdout.trim()) await this.git(workdir, ["remote", "add", "origin", url.stdout.trim()]);
      // Remote-tracking refs as the factory repo has them. Objects are already reachable via alternates.
      await this.git(workdir, [
        "fetch", "--quiet", "--no-tags", spec.repo,
        "+refs/remotes/origin/*:refs/remotes/origin/*", "^refs/remotes/origin/HEAD",
      ]);

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

  /** Fetches only the base branch, so it touches no other ref in the shared checkout. */
  async updateBase(spec: Pick<SandboxSpec, "repo" | "base_ref">): Promise<string> {
    const ref = `refs/heads/${spec.base_ref}`;
    return this.serialized(spec.repo, async () => {
      await this.fetchWithRetry(spec.repo, ["fetch", "--quiet", "--no-tags", "origin", `+${ref}:refs/remotes/origin/${spec.base_ref}`]);
      return (await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `origin/${spec.base_ref}^{commit}`])).stdout.trim();
    });
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

  private async git(cwd: string, args: string[], check = true): Promise<ExecResult> {
    const r = await this.run(["git", "-C", cwd, ...args], { cwd, env: baseEnv({ GIT_TERMINAL_PROMPT: "0" }) });
    if (check && r.exit_code !== 0) throw gitError(args, r);
    return r;
  }
}

function gitError(args: readonly string[], r: ExecResult): Error {
  return new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
}
