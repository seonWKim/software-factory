import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../interfaces/sandbox.js";
import { baseEnv, runProcess } from "../process/run-process.js";

/** Name of the empty hooks folder under the worktrees dir: beside the run folders, never inside one. */
export const EMPTY_HOOKS_DIR = ".empty-hooks";

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
  constructor(private readonly worktreesDir: string) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `sbx_${randomUUID().slice(0, 8)}`;
    const workdir = join(this.worktreesDir, id);
    await mkdir(this.worktreesDir, { recursive: true });
    const hooks = await this.emptyHooks();

    // Trusted: the factory repo's own refs and config, never anything an agent wrote.
    await this.git(spec.repo, ["fetch", "--quiet", "--prune", "origin"]);
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
    });
  }

  async copyIn(handle: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    await cp(hostPath, join(handle.workdir, sandboxPath), { recursive: true });
  }

  async copyOut(handle: SandboxHandle, sandboxPath: string, hostPath: string): Promise<void> {
    await cp(join(handle.workdir, sandboxPath), hostPath, { recursive: true });
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

  async updateBase(spec: Pick<SandboxSpec, "repo" | "base_ref">): Promise<string> {
    await this.git(spec.repo, ["fetch", "--quiet", "--prune", "origin"]);
    return (await this.git(spec.repo, ["rev-parse", "--verify", "--end-of-options", `origin/${spec.base_ref}^{commit}`])).stdout.trim();
  }

  private async git(cwd: string, args: string[], check = true): Promise<ExecResult> {
    const r = await runProcess(["git", "-C", cwd, ...args], { cwd, env: baseEnv({ GIT_TERMINAL_PROMPT: "0" }) });
    if (check && r.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
    return r;
  }
}
