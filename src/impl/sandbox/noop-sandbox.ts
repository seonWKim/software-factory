import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../interfaces/sandbox.js";
import { baseEnv, runProcess } from "../process/run-process.js";

/**
 * A git worktree on the host. No isolation: the agent has the host user's access, so the
 * harness-level guards (G3 via Claude Code's OS sandbox, G4) carry the weight (design §5).
 */
export class NoOpSandbox implements Sandbox {
  constructor(private readonly worktreesDir: string) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const id = `sbx_${randomUUID().slice(0, 8)}`;
    const workdir = join(this.worktreesDir, id);
    await mkdir(this.worktreesDir, { recursive: true });
    await this.git(spec.repo, ["fetch", "--quiet", "--prune", "origin"]);

    if (spec.branch === null) {
      await this.git(spec.repo, ["worktree", "add", "--quiet", "--detach", workdir, `origin/${spec.base_ref}`]);
    } else {
      const remote = await this.git(spec.repo, ["rev-parse", "--verify", "--quiet", `origin/${spec.branch}`], false);
      const start = remote.exit_code === 0 ? `origin/${spec.branch}` : `origin/${spec.base_ref}`;
      // -f: a worktree left behind by a crashed run may still hold the branch.
      await this.git(spec.repo, ["worktree", "add", "--quiet", "-f", "-B", spec.branch, workdir, start]);
    }
    return { id, workdir };
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

  async destroy(handle: SandboxHandle): Promise<void> {
    await runProcess(["git", "worktree", "remove", "--force", handle.workdir], {
      cwd: this.worktreesDir,
      env: baseEnv({ GIT_TERMINAL_PROMPT: "0" }),
    }).catch(() => undefined);
    await rm(handle.workdir, { recursive: true, force: true });
  }

  private async git(repo: string, args: string[], check = true): Promise<ExecResult> {
    const r = await runProcess(["git", "-C", repo, ...args], { cwd: repo, env: baseEnv({ GIT_TERMINAL_PROMPT: "0" }) });
    if (check && r.exit_code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
    return r;
  }
}
