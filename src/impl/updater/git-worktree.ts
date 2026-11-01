import { existsSync } from "node:fs";
import { lstat, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";
import type { ExecResult } from "../../interfaces/sandbox.js";
import {
  CODE_ROOT_ENV,
  type ChildHandle,
  type ChildLauncher,
  type CommandRunner,
  SUPERVISED_ENV,
  type SupervisorStatus,
  type Updater,
} from "../../interfaces/updater.js";

/** Added to run_timeout_ms before a draining child is hard-stopped. */
export const DRAIN_MARGIN_MS = 60_000;
/** Written into dist/ after a successful build: the revision that dist/ was built from. */
const BUILT_MARKER = ".factory-built-rev";
/** Written into node_modules/ after a successful `npm ci`: the revision whose lock file it installed. */
const INSTALLED_MARKER = ".factory-installed-rev";
const TAIL = 2000;

/** Files whose change needs a build and a restart. Anything else (docs) only moves the runtime copy. */
export function isCodePath(file: string): boolean {
  return (
    file.startsWith("src/") ||
    file.startsWith("prompts/") ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "factory.config.json" ||
    /^tsconfig[^/]*\.json$/.test(file)
  );
}

export interface GitWorktreeOptions {
  /** The main checkout: state root, and the repository whose origin/<base> the runtime copy follows. */
  repoPath: string;
  /** `<state_dir>/runtime`: the detached worktree the child runs from. */
  runtimeDir: string;
  /** `<state_dir>/runtime-next`: where a new revision is built while the old child keeps running. */
  stagingDir: string;
  baseBranch: string;
  run: CommandRunner;
  launcher: ChildLauncher;
  clock: Clock;
  log: Logger;
  /** Environment for git and npm (`baseEnv()`): no secrets. */
  env: Readonly<Record<string, string>>;
  /** A draining child gets this plus DRAIN_MARGIN_MS before it is hard-stopped. */
  runTimeoutMs: number;
  childArgs?: readonly string[];
  /** Where to write the SupervisorStatus for the status page; none: not written. */
  statusFile?: string;
}

const tail = (s: string, n = TAIL) => (s.length > n ? s.slice(-n) : s);

/**
 * Runs the factory from a built runtime copy of origin/<base_branch> and moves it forward. Order on a code
 * change: fetch, build the new revision in a separate worktree while the old child runs, and only if that
 * build succeeded: drain the child, wait for it to exit, fast-forward the runtime copy, swap in the built
 * output (build there if it is not already built), restart. A failed build never touches the running child.
 * The main checkout is only fast-forwarded (when on the base branch and clean); nothing else is done to it.
 */
export class GitWorktreeUpdater implements Updater {
  readonly mode = "supervised" as const;
  private child: ChildHandle | null = null;
  /** Children we asked to exit; any other exit is a crash. */
  private readonly stopping = new WeakSet<ChildHandle>();
  /** A revision whose build failed: not built again until the next change. */
  private failedRev: string | null = null;
  /** The origin revision the main checkout was last tried against (one attempt, one log line per commit). */
  private mainTriedFor: string | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  /** The revision the current child was started from. */
  private runningRev: string | null = null;

  constructor(private readonly o: GitWorktreeOptions) {}

  get drainTimeoutMs(): number {
    return this.o.runTimeoutMs + DRAIN_MARGIN_MS;
  }

  childPid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    const { runtimeDir, repoPath } = this.o;
    const origin = await this.fetch();
    await this.fastForwardMain(origin);
    if (!existsSync(join(runtimeDir, ".git"))) {
      this.o.log.info("creating the runtime copy", { rev: origin });
      await this.git(repoPath, ["worktree", "prune"]);
      await this.git(repoPath, ["worktree", "add", "--detach", runtimeDir, origin]);
    } else {
      const head = await this.head(runtimeDir);
      if (head !== origin) await this.update(origin);
    }
    await this.ensureChild();
  }

  async check(): Promise<string | null> {
    const origin = await this.fetch();
    await this.fastForwardMain(origin);
    const current = await this.head(this.o.runtimeDir);
    if (origin === current || origin === this.failedRev) return null;
    return origin;
  }

  async poll(): Promise<void> {
    if (this.closed) return;
    const target = await this.check();
    if (target && !this.closed) await this.update(target);
    await this.ensureChild();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    const child = this.child;
    if (!child) return void (await this.report("stopped", null));
    this.stopping.add(child);
    child.kill("SIGTERM");
    if (!(await this.waitExit(child))) {
      this.o.log.error("child did not exit after SIGTERM within the drain timeout; hard stop", {
        pid: child.pid,
        timeout_ms: this.drainTimeoutMs,
      });
      child.kill("SIGKILL");
      await child.exited;
    }
    if (this.child === child) this.child = null;
    await this.report("stopped", null);
  }

  /** Moves the runtime copy from its HEAD to `target`, building and restarting only for code changes. */
  private async update(target: string): Promise<void> {
    const { runtimeDir, repoPath, log } = this.o;
    const current = await this.head(runtimeDir);
    if (!(await this.isAncestor(current, target))) {
      log.error("origin is not a fast-forward of the runtime copy; not updating", { current, rev: target });
      this.failedRev = target;
      return;
    }
    const files = (await this.git(repoPath, ["diff", "--name-only", current, target])).split("\n").filter(Boolean);
    if (!files.some(isCodePath)) {
      const built = await this.builtRev(runtimeDir);
      await this.fastForwardRuntime(target);
      if (built === current) await writeFile(join(runtimeDir, "dist", BUILT_MARKER), target);
      log.info("docs-only change: runtime copy moved, child untouched", { rev: target });
      return;
    }
    if (!this.child) {
      // Nothing is running (first start, or the last build failed): move and let ensureChild build it.
      await this.fastForwardRuntime(target);
      return;
    }
    log.info("code change: building the new revision beside the running child", { rev: target, pid: this.child.pid });
    await this.report("building", target);
    if (!(await this.prepare(target, files.includes("package-lock.json")))) {
      this.failedRev = target;
      await this.report("build_failed", target);
      await this.removeStaging().catch(() => undefined);
      return;
    }
    if (this.closed) return;
    await this.report("draining", target);
    await this.drain();
    if (this.closed) return;
    await this.report("restarting", target);
    await this.fastForwardRuntime(target);
    await this.swapIn();
    // ensureChild() (next in poll) builds if the swap did not leave a build of `target`, then restarts.
  }

  /** Builds `rev` in the staging worktree. Installs only when the lock file changed. */
  private async prepare(rev: string, lockChanged: boolean): Promise<boolean> {
    const { stagingDir, repoPath, runtimeDir } = this.o;
    await this.removeStaging();
    await this.git(repoPath, ["worktree", "add", "--detach", stagingDir, rev]);
    if (!lockChanged) await symlink(join(runtimeDir, "node_modules"), join(stagingDir, "node_modules"), "dir");
    return this.build(stagingDir, rev, lockChanged);
  }

  /** The child has exited: move the staging build (and its node_modules, if it installed) into the runtime copy. */
  private async swapIn(): Promise<void> {
    const { stagingDir, runtimeDir } = this.o;
    const modules = join(stagingDir, "node_modules");
    const st = await lstat(modules).catch(() => null);
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      await rm(join(runtimeDir, "node_modules"), { recursive: true, force: true });
      await rename(modules, join(runtimeDir, "node_modules"));
    }
    await rm(join(runtimeDir, "dist"), { recursive: true, force: true });
    await rename(join(stagingDir, "dist"), join(runtimeDir, "dist"));
    await this.removeStaging();
  }

  private async removeStaging(): Promise<void> {
    const { stagingDir, repoPath } = this.o;
    if (existsSync(stagingDir)) {
      const r = await this.exec(repoPath, ["git", "worktree", "remove", "--force", stagingDir]);
      if (r.exit_code !== 0) await rm(stagingDir, { recursive: true, force: true });
    }
    await this.git(repoPath, ["worktree", "prune"]);
  }

  /** Writes the status file (atomically: a temp file, then rename). A failure is logged, never thrown. */
  private async report(state: SupervisorStatus["state"], target: string | null): Promise<void> {
    const file = this.o.statusFile;
    if (!file) return;
    const status: SupervisorStatus = {
      state,
      rev: this.runningRev,
      target_rev: target,
      child_pid: state === "stopped" ? null : (this.child?.pid ?? null),
      since: this.o.clock.now().toISOString(),
    };
    try {
      await writeFile(`${file}.tmp`, `${JSON.stringify(status)}\n`);
      await rename(`${file}.tmp`, file);
    } catch (err) {
      this.o.log.warn("could not write the supervisor status", { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    }
  }

  /** Starts the child from the runtime copy, building it first if needed. Never starts a tree that did not build. */
  private async ensureChild(): Promise<void> {
    const { runtimeDir } = this.o;
    if (this.closed || this.child) return;
    const head = await this.head(runtimeDir);
    if ((await this.builtRev(runtimeDir)) !== head) {
      if (head === this.failedRev) return;
      if (!(await this.build(runtimeDir, head, await this.needsInstall(runtimeDir, head)))) {
        this.failedRev = head;
        return;
      }
    }
    if (this.closed) return;
    this.launch(head);
    await this.report("running", null);
  }

  private launch(rev: string): void {
    const { runtimeDir, repoPath, launcher, log } = this.o;
    const child = launcher.launch({
      entry: join(runtimeDir, "dist", "main.js"),
      args: this.o.childArgs ?? ["dev"],
      cwd: repoPath,
      env: { [CODE_ROOT_ENV]: runtimeDir, [SUPERVISED_ENV]: "1" },
    });
    this.child = child;
    this.runningRev = rev;
    log.info("child started", { pid: child.pid, rev });
    void child.exited.then((code) => {
      if (this.child === child) {
        this.child = null;
        if (!this.closed && !this.stopping.has(child)) void this.report("stopped", null);
      }
      if (!this.stopping.has(child)) log.warn("child exited unexpectedly; restarting on the next poll", { pid: child.pid, exit_code: code });
    });
  }

  /** Asks the child to drain and waits for it to exit; hard-stops it after run_timeout_ms plus the margin. */
  private async drain(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const { log } = this.o;
    this.stopping.add(child);
    log.info("drain requested", { pid: child.pid });
    child.requestDrain();
    if (await this.waitExit(child)) {
      log.info("child drained and exited", { pid: child.pid, acknowledged: child.drainAcknowledged });
    } else {
      log.error("child did not exit within the drain timeout; hard stop", { pid: child.pid, timeout_ms: this.drainTimeoutMs });
      child.kill("SIGKILL");
      await child.exited;
    }
    if (this.child === child) this.child = null;
  }

  /** True if the child exited within the drain timeout. */
  private async waitExit(child: ChildHandle): Promise<boolean> {
    const timer = new AbortController();
    const exited = await Promise.race([
      child.exited.then(() => true),
      this.o.clock.sleep(this.drainTimeoutMs, timer.signal).then(
        () => false,
        () => true,
      ),
    ]);
    timer.abort();
    return exited;
  }

  /** `npm ci` (if asked) and `npm run build` in `dir`. Logs the failing step and its output tail. */
  private async build(dir: string, rev: string, install: boolean): Promise<boolean> {
    await rm(join(dir, "dist", BUILT_MARKER), { force: true });
    const steps: string[][] = install ? [["npm", "ci"], ["npm", "run", "build"]] : [["npm", "run", "build"]];
    for (const cmd of steps) {
      const r = await this.exec(dir, cmd);
      if (r.exit_code !== 0) {
        this.o.log.error("build failed; the running child is untouched and this revision will not be started", {
          rev,
          step: cmd.join(" "),
          exit_code: r.exit_code,
          output_tail: tail(`${r.stdout}${r.stderr}`),
        });
        return false;
      }
      if (cmd[1] === "ci") await writeFile(join(dir, "node_modules", INSTALLED_MARKER), rev);
    }
    await writeFile(join(dir, "dist", BUILT_MARKER), rev);
    this.o.log.info("built", { rev });
    return true;
  }

  /** Install when node_modules is missing, of unknown origin, or the lock file changed since it was installed. */
  private async needsInstall(dir: string, head: string): Promise<boolean> {
    const installed = await readFile(join(dir, "node_modules", INSTALLED_MARKER), "utf8").then(
      (s) => s.trim(),
      () => null,
    );
    if (!installed) return true;
    if (installed === head) return false;
    const files = await this.git(this.o.repoPath, ["diff", "--name-only", installed, head]);
    return files.split("\n").includes("package-lock.json");
  }

  private async builtRev(dir: string): Promise<string | null> {
    return readFile(join(dir, "dist", BUILT_MARKER), "utf8").then(
      (s) => s.trim(),
      () => null,
    );
  }

  /**
   * `git pull --ff-only` semantics for the main checkout, once per new origin commit: only on the base branch
   * and with an empty `git status --porcelain`. Never checks out, stashes, resets or switches branches.
   */
  private async fastForwardMain(origin: string): Promise<void> {
    const { repoPath, baseBranch, log } = this.o;
    if (this.mainTriedFor === origin) return;
    this.mainTriedFor = origin;
    if ((await this.head(repoPath)) === origin) return;
    const skip = (reason: string) => log.info("main checkout not fast-forwarded", { reason, rev: origin });
    const branch = (await this.git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== baseBranch) return skip(`not on base branch ${baseBranch}`);
    if ((await this.git(repoPath, ["status", "--porcelain"])).trim()) return skip("dirty: uncommitted changes");
    const r = await this.exec(repoPath, ["git", "merge", "--ff-only", "--quiet", `origin/${baseBranch}`]);
    if (r.exit_code !== 0) return skip(`ff failed: ${tail(r.stderr.trim(), 300)}`);
    log.info("main checkout fast-forwarded", { rev: origin });
  }

  private async fastForwardRuntime(target: string): Promise<void> {
    await this.git(this.o.runtimeDir, ["merge", "--ff-only", "--quiet", target]);
  }

  private async fetch(): Promise<string> {
    const { repoPath, baseBranch } = this.o;
    await this.git(repoPath, ["fetch", "--quiet", "origin", baseBranch]);
    return (await this.git(repoPath, ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`])).trim();
  }

  private async head(dir: string): Promise<string> {
    return (await this.git(dir, ["rev-parse", "HEAD"])).trim();
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.exec(this.o.repoPath, ["git", "merge-base", "--is-ancestor", a, b]);
    if (r.exit_code === 0) return true;
    if (r.exit_code === 1) return false;
    throw new Error(`git merge-base failed (exit ${r.exit_code}): ${tail(r.stderr, 300)}`);
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.exec(cwd, ["git", ...args]);
    if (r.exit_code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.exit_code}): ${tail(r.stderr.trim(), 300)}`);
    return r.stdout;
  }

  private exec(cwd: string, cmd: readonly string[]): Promise<ExecResult> {
    return this.o.run(cmd, { cwd, env: this.o.env, signal: this.abort.signal });
  }
}
