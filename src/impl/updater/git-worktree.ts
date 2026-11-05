import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";
import type { ExecResult } from "../../interfaces/sandbox.js";
import {
  CODE_ROOT_ENV,
  type ChildHandle,
  type ChildLauncher,
  type CommandRunner,
  MIGRATION_PENDING_CODE,
  SUPERVISED_ENV,
  type SupervisorRequest,
  type SupervisorStatus,
  type Updater,
  WORKER_INDEX_BASE_ENV,
} from "../../interfaces/updater.js";

/** Added to run_timeout_ms before a draining child is hard-stopped. */
export const DRAIN_MARGIN_MS = 60_000;
/** Written into dist/ after a successful build: the revision that dist/ was built from. */
const BUILT_MARKER = ".factory-built-rev";
/** Written into a version folder when its child starts: the child's pid. The orphan sweep reads it. */
export const PID_FILE = ".factory-pid";
const TAIL = 2000;
/** How long one migration check (`migrate --status --json`) may take. */
const CHECK_TIMEOUT_MS = 120_000;

/**
 * Files whose change needs a build and a restart. Anything else (docs) only moves the newest folder.
 * web/ is the status app that `npm run build` builds into web/dist (design §9).
 */
export function isCodePath(file: string): boolean {
  return (
    file.startsWith("src/") ||
    file.startsWith("web/") ||
    file.startsWith("prompts/") ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "factory.config.json" ||
    /^tsconfig[^/]*\.json$/.test(file)
  );
}

export interface GitWorktreeOptions {
  /** The main checkout: state root, and the repository whose origin/<base> the version folders follow. */
  repoPath: string;
  /** Legacy `<state_dir>/runtime` (drain-then-start layout): removed on the first start under versions/. Its
   * parent is the state dir, where versions/ and deps/ live unless set below. */
  runtimeDir: string;
  /** Legacy `<state_dir>/runtime-next`: removed together with runtimeDir. */
  stagingDir: string;
  /** `<state_dir>/versions`: one detached worktree per version, `versions/<short-rev>`. */
  versionsDir?: string;
  /** `<state_dir>/deps`: node_modules installs, `deps/<hash of package-lock.json>/node_modules`. */
  depsDir?: string;
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
  /** Whether a pid names a live process (the orphan sweep). Default: `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  /** `<state_dir>/supervisor-request.json`, written by `npm run migrate`; none: no request is read. */
  requestFile?: string;
  /** Written into the status file so `npm run migrate` can tell a live supervisor. Default: process.pid. */
  supervisorPid?: number;
  /** `updater.auto_migrate`: run the target's migrate itself after draining, instead of waiting for the owner. */
  autoMigrate?: boolean;
  /** Added to `env` for a version's `migrate` (the check and auto_migrate), e.g. the secret file's path. */
  migrateEnv?: Readonly<Record<string, string>>;
}

/** A built revision whose migration check lists pending steps: not started until they are applied. */
interface Pending {
  rev: string;
  dir: string;
  steps: string[];
  /** Why the check itself failed, or null. */
  error: string | null;
}

/** One child this supervisor started, and the folder and worker index block it runs with. */
interface Live {
  child: ChildHandle;
  dir: string;
  rev: string;
  /** Worker indexes [base, base + size). */
  base: number;
  size: number;
  draining: boolean;
  /** Cancels the drain's hard-stop timer when the child exits. */
  timer: AbortController | null;
}

const tail = (s: string, n = TAIL) => (s.length > n ? s.slice(-n) : s);

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if `path` is `dir` or below it. */
const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/**
 * Runs the factory from built versions of origin/<base_branch>, each in its own detached worktree under
 * `<state_dir>/versions/`, and moves it forward start-then-drain. On a code change: fetch, build the new
 * revision in a new folder while the old child keeps claiming, and only if that build succeeded: start the new
 * child at once and ask every older child to drain. An old child finishes its in-flight runs from its own
 * folder and exits by itself; it is hard-stopped only after run_timeout_ms plus the margin. poll never waits
 * for an old child. A failed build never touches a running child. The main checkout is only fast-forwarded
 * (when on the base branch and clean); nothing else is done to it.
 *
 * One supervisor per state directory is assumed: index blocks and the live set are kept in this process.
 */
export class GitWorktreeUpdater implements Updater {
  readonly mode = "supervised" as const;
  /** Every child started here that has not exited: the claiming one and any draining ones. */
  private live: Live[] = [];
  /** The newest child: the one that claims. */
  private current: Live | null = null;
  /** The folder the claiming child runs (or restarts) from. */
  private newest: string | null = null;
  /** A folder being created or built: never removed meanwhile. */
  private building: string | null = null;
  /** Folders found at start whose pid file names a live process this supervisor did not start. */
  private readonly foreign = new Set<string>();
  /** Build order of folders built by this process; newer than any found on disk. */
  private readonly buildSeq = new Map<string, number>();
  private seq = 0;
  /** Children we asked to stop on shutdown: their exit is not a crash. */
  private readonly stopping = new WeakSet<ChildHandle>();
  /** A revision whose build failed: not built again until the next change. */
  private failedRev: string | null = null;
  /** The origin revision the main checkout was last tried against (one attempt, one log line per commit). */
  private mainTriedFor: string | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  /** The revision the claiming child was started from. */
  private runningRev: string | null = null;
  /** The last status written: a repeat of the same state keeps its `since`. */
  private lastStatus: SupervisorStatus | null = null;
  /** The crash loop in progress: its error and when it began. */
  private crash: { error: string | null; since: string } | null = null;
  /** The status write in progress. */
  private reporting: Promise<void> = Promise.resolve();
  /** The built target waiting for its migration steps; it stays in its folder until superseded or started. */
  private pending: Pending | null = null;
  /** True while a drain request from `npm run migrate` stands: no child is started. */
  private held = false;
  /** A revision whose automatic migrate failed: not tried again automatically. */
  private autoFailedRev: string | null = null;

  constructor(private readonly o: GitWorktreeOptions) {}

  get drainTimeoutMs(): number {
    return this.o.runTimeoutMs + DRAIN_MARGIN_MS;
  }

  private get versionsDir(): string {
    return this.o.versionsDir ?? join(dirname(this.o.runtimeDir), "versions");
  }

  private get depsDir(): string {
    return this.o.depsDir ?? join(dirname(this.o.runtimeDir), "deps");
  }

  childPid(): number | null {
    return this.current?.child.pid ?? null;
  }

  childPids(): number[] {
    return this.live.map((l) => l.child.pid);
  }

  async start(): Promise<void> {
    const origin = await this.fetch();
    await this.fastForwardMain(origin);
    await this.sweep(origin);
    if (this.foreign.size === 0) await this.removeLegacy();
    if (!this.newest) {
      this.o.log.info("creating a version folder", { rev: origin });
      this.newest = await this.create(origin);
    }
    if (!(await this.handleRequest())) await this.ensureChild(true);
    if (!this.closed) await this.cleanup();
  }

  async check(): Promise<string | null> {
    const origin = await this.fetch();
    await this.fastForwardMain(origin);
    if (origin === this.failedRev) return null;
    if (this.pending?.rev === origin) return null; // poll checks its steps again
    if (this.newest && (await this.head(this.newest)) === origin) return null;
    return origin;
  }

  async poll(): Promise<void> {
    if (this.closed) return;
    if (await this.handleRequest()) {
      if (!this.closed) await this.cleanup();
      return;
    }
    const target = await this.check();
    if (target && !this.closed) await this.update(target);
    else if (this.pending && !this.closed) await this.settlePending(this.pending.rev, this.pending.dir);
    await this.ensureChild();
    if (!this.closed) await this.cleanup();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    const all = [...this.live];
    for (const l of all) l.timer?.abort();
    if (all.length) this.o.log.info("stopping every live child", { pids: all.map((l) => l.child.pid).join(",") });
    await Promise.all(all.map((l) => this.stop(l.child)));
    this.current = null;
    await this.report("stopped", null);
  }

  // --- pending migration steps -------------------------------------------------------------------------------

  /**
   * The built revision in `dir`: its own `migrate --status --json`. Clean: start it (start-then-drain). Steps
   * pending (or the check failed): it waits as `pending` and nothing is drained or started; with auto_migrate
   * the old children are drained, the target's migrate runs, and then it starts.
   */
  private async settlePending(rev: string, dir: string): Promise<void> {
    const { log } = this.o;
    const check = await this.migrationCheck(dir);
    if (this.closed) return;
    if (check.error === null && check.steps.length === 0) {
      if (this.pending) log.info("migration steps applied: starting the waiting revision", { rev, dir });
      this.pending = null;
      this.newest = dir;
      await this.startChild(dir, rev);
      return;
    }
    const first = this.pending?.rev !== rev;
    this.pending = { rev, dir, steps: check.steps, error: check.error };
    if (first) {
      log.warn("new revision built but migration steps are pending: not started, nothing drained; run `npm run migrate`", {
        rev,
        pending: check.steps.join(", "),
        ...(check.error ? { error: check.error } : {}),
      });
    }
    if (this.o.autoMigrate && check.error === null && this.autoFailedRev !== rev) {
      await this.autoMigrate(this.pending);
      return;
    }
    await this.report("migration_pending", rev, check.error);
  }

  /** `updater.auto_migrate`: drain every live child and wait for it, run the target's migrate, then start it. */
  private async autoMigrate(p: Pending): Promise<void> {
    const { log } = this.o;
    log.info("auto_migrate: draining every child, then applying the pending steps", { rev: p.rev, pending: p.steps.join(", ") });
    this.held = true;
    try {
      for (const l of this.live) if (!l.draining) this.drain(l);
      await this.report("draining", p.rev);
      await Promise.all(this.live.map((l) => l.child.exited));
      if (this.closed) return;
      const r = await this.exec(this.o.repoPath, this.migrateCmd(p.dir, ["--no-drain"]), this.migrateEnvFor(p.dir));
      if (this.closed) return;
      if (r.exit_code === 0) {
        log.info("auto_migrate: steps applied; starting the new revision", { rev: p.rev });
        this.held = false;
        this.pending = null;
        this.newest = p.dir;
        await this.startChild(p.dir, p.rev);
        return;
      }
      this.autoFailedRev = p.rev;
      p.error = `npm run migrate failed (exit ${r.exit_code}): ${tail(`${r.stdout}${r.stderr}`.trim(), 300)}`;
      log.error("auto_migrate: migrate failed; restarting the old revision", { rev: p.rev, exit_code: r.exit_code, output_tail: tail(`${r.stdout}${r.stderr}`) });
    } finally {
      this.held = false;
    }
    await this.report("migration_pending", p.rev, p.error);
  }

  /** Runs `migrate --status --json` from the folder's build. A failed or unreadable check counts as pending. */
  private async migrationCheck(dir: string): Promise<{ steps: string[]; error: string | null }> {
    const r = await this.exec(this.o.repoPath, this.migrateCmd(dir, ["--status", "--json"]), this.migrateEnvFor(dir), CHECK_TIMEOUT_MS);
    const out = `${r.stdout}`.trim().split("\n").filter(Boolean).at(-1) ?? "";
    let pending: unknown;
    try {
      pending = (JSON.parse(out) as { pending?: unknown }).pending;
    } catch {
      pending = undefined;
    }
    if (r.exit_code !== 0 || !Array.isArray(pending) || !pending.every((p) => typeof p === "string")) {
      const error = `migration check failed (exit ${r.exit_code}): ${tail(`${r.stdout}${r.stderr}`.trim(), 300)}`;
      this.o.log.error("migration check of the new revision failed; it is not started", { dir, error });
      return { steps: [], error };
    }
    return { steps: pending as string[], error: null };
  }

  private migrateCmd(dir: string, flags: string[]): string[] {
    return ["node", "--disable-warning=ExperimentalWarning", join(dir, "dist", "main.js"), "migrate", ...flags];
  }

  private migrateEnvFor(dir: string): Record<string, string> {
    return { ...this.o.env, ...this.o.migrateEnv, [CODE_ROOT_ENV]: dir };
  }

  /**
   * Reads the request `npm run migrate` wrote. drain: drain every child and start none (true: poll does nothing
   * else). start: start the waiting target. cancel, or a drain whose migrate process is gone: resume, so the old
   * revision restarts from its own folder. start and cancel are removed once handled.
   */
  private async handleRequest(): Promise<boolean> {
    const file = this.o.requestFile;
    if (!file || this.closed) return false;
    let req: SupervisorRequest | null = null;
    try {
      req = JSON.parse(await readFile(file, "utf8")) as SupervisorRequest;
    } catch {
      req = null;
    }
    const { log } = this.o;
    if (!req) {
      this.held = false;
      return false;
    }
    if (req.action === "drain" && this.pidAlive(req.pid)) {
      if (!this.held) {
        log.info("npm run migrate asked for a drain: every child drains, none starts until it is done", { migrate_pid: req.pid, rev: req.target_rev });
        this.held = true;
        for (const l of this.live) if (!l.draining) this.drain(l);
      }
      await this.report("draining", this.pending?.rev ?? req.target_rev);
      return true;
    }
    this.held = false;
    await unlink(file).catch(() => undefined);
    if (req.action === "start") {
      const p = this.pending;
      if (p && (req.target_rev === null || req.target_rev === p.rev)) {
        log.info("npm run migrate applied the steps: starting the waiting revision", { rev: p.rev, dir: p.dir });
        this.pending = null;
        this.newest = p.dir;
        await this.startChild(p.dir, p.rev);
      } else log.info("npm run migrate applied the steps: resuming", { rev: req.target_rev });
      return false;
    }
    log.warn(req.action === "drain" ? "the npm run migrate that asked for a drain is gone: resuming" : "npm run migrate was cancelled: resuming the old revision", {
      migrate_pid: req.pid,
    });
    return false;
  }

  /** SIGTERM, then SIGKILL if it has not exited within the drain timeout. Resolves once it exited. */
  private async stop(child: ChildHandle): Promise<void> {
    this.stopping.add(child);
    child.kill("SIGTERM");
    if (await this.waitExit(child)) return;
    this.o.log.error("child did not exit after SIGTERM within the drain timeout; hard stop", {
      pid: child.pid,
      timeout_ms: this.drainTimeoutMs,
    });
    child.kill("SIGKILL");
    await child.exited;
  }

  /** Moves to `target`: docs-only moves the newest folder; a code change builds a new folder and starts it. */
  private async update(target: string): Promise<void> {
    const { repoPath, log } = this.o;
    const newest = this.newest;
    if (!newest) {
      this.newest = await this.create(target);
      return; // ensureChild (next in poll) builds and starts it
    }
    const current = await this.head(newest);
    if (!(await this.isAncestor(current, target))) {
      log.error("origin is not a fast-forward of the newest folder; not updating", { current, rev: target });
      this.failedRev = target;
      return;
    }
    const files = (await this.git(repoPath, ["diff", "--name-only", current, target])).split("\n").filter(Boolean);
    if (!files.some(isCodePath)) {
      // Only the newest folder moves: an older child never sees files change under it.
      const built = await this.builtRev(newest);
      await this.git(newest, ["merge", "--ff-only", "--quiet", target]);
      if (built === current) await writeFile(join(newest, "dist", BUILT_MARKER), target);
      log.info("docs-only change: newest folder moved, children untouched", { rev: target, dir: newest });
      return;
    }
    log.info("code change: building the new revision in its own folder", { rev: target, pid: this.childPid() });
    // A newer commit replaces a waiting target: its folder is no longer kept.
    if (this.pending) log.info("a newer revision replaces the one waiting for migration steps", { waiting: this.pending.rev, rev: target });
    this.pending = null;
    await this.report("building", target);
    let dir: string | null = null;
    let ok = false;
    try {
      dir = await this.create(target);
      this.building = dir;
      ok = await this.build(dir, target);
    } finally {
      this.building = null;
    }
    if (!ok) {
      this.failedRev = target;
      await this.report("build_failed", target);
      await this.removeFolder(dir).catch((err: unknown) =>
        log.warn("could not remove the failed build's folder", { dir, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" }),
      );
      return;
    }
    if (this.closed || !dir) return;
    // The schema check before anything drains: pending steps keep the old child running.
    await this.settlePending(target, dir);
  }

  /**
   * Starts a child from the newest folder when none claims, building it first if needed. `check`: run the
   * migration check first (supervisor start). Nothing starts while held or while the newest folder itself waits
   * for migration steps (its child exited on them).
   */
  private async ensureChild(check = false): Promise<void> {
    if (this.closed || this.current || !this.newest || this.held) return;
    if (this.pending && this.pending.dir === this.newest) return;
    const dir = this.newest;
    const head = await this.head(dir);
    if ((await this.builtRev(dir)) !== head) {
      if (head === this.failedRev) return;
      this.building = dir;
      let ok = false;
      try {
        ok = await this.build(dir, head);
      } finally {
        this.building = null;
      }
      if (!ok) {
        this.failedRev = head;
        return;
      }
    }
    if (this.closed) return;
    if (check) return this.settlePending(head, dir);
    await this.startChild(dir, head);
  }

  /** Launches a child from `dir` with its own worker index block, then asks every older child to drain. */
  private async startChild(dir: string, rev: string): Promise<void> {
    const { launcher, repoPath, log } = this.o;
    const size = await this.blockSize(dir);
    if (this.closed) return; // shutdown took its list of children: start none after it
    const base = this.freeBase(size);
    const child = launcher.launch({
      entry: join(dir, "dist", "main.js"),
      args: this.o.childArgs ?? ["dev"],
      cwd: repoPath,
      env: { [CODE_ROOT_ENV]: dir, [SUPERVISED_ENV]: "1", [WORKER_INDEX_BASE_ENV]: String(base) },
    });
    const started: Live = { child, dir, rev, base, size, draining: false, timer: null };
    const older = this.live.filter((l) => !l.draining);
    this.live.push(started);
    this.current = started;
    this.runningRev = rev;
    void child.exited.then((code) => this.onExit(started, code));
    log.info("child started", { pid: child.pid, rev, dir, worker_index_base: base, workers: size });
    // In the same synchronous step as the launch, so a shutdown sees either no new child or every drain.
    for (const old of older) this.drain(old);
    await writeFile(join(dir, PID_FILE), `${child.pid}\n`).catch((err: unknown) =>
      log.warn("could not write the pid file", { dir, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" }),
    );
    await this.reportIdle();
  }

  /** running, or migration_pending while a built target waits for its steps. */
  private reportIdle(): Promise<void> {
    if (this.held) return this.report("draining", this.pending?.rev ?? null);
    if (this.pending) return this.report("migration_pending", this.pending.rev, this.pending.error);
    return this.report("running", null);
  }

  /** Asks an old child to drain; it exits by itself after its in-flight runs. Hard stop only on timeout. Never awaited. */
  private drain(old: Live): void {
    const { log, clock } = this.o;
    if (this.closed) return; // shutdown stops it instead
    old.draining = true;
    log.info("drain requested", { pid: old.child.pid, rev: old.rev });
    old.child.requestDrain();
    const timer = new AbortController();
    old.timer = timer;
    clock.sleep(this.drainTimeoutMs, timer.signal).then(
      () => {
        if (!this.live.includes(old)) return;
        log.error("old child did not exit within the drain timeout; hard stop", { pid: old.child.pid, timeout_ms: this.drainTimeoutMs });
        old.child.kill("SIGKILL");
      },
      () => undefined,
    );
  }

  private onExit(l: Live, code: number | null): void {
    const { log } = this.o;
    this.live = this.live.filter((x) => x !== l);
    l.timer?.abort();
    if (this.current === l) this.current = null;
    if (this.stopping.has(l.child)) return;
    if (l.draining) {
      log.info("old child drained and exited", { pid: l.child.pid, rev: l.rev, acknowledged: l.child.drainAcknowledged, exit_code: code });
      if (!this.closed && (this.current || this.held)) void this.reportIdle();
      return;
    }
    if (l.child.lastErrorCode === MIGRATION_PENDING_CODE) {
      // Not a crash loop: it waits, like a target whose check listed steps, until they are applied.
      this.pending = { rev: l.rev, dir: l.dir, steps: [...(l.child.lastErrorPending ?? [])], error: null };
      if (!this.closed) void this.report("migration_pending", l.rev);
      log.warn("child exited on pending migration steps; not restarted until they are applied (npm run migrate)", {
        pid: l.child.pid,
        rev: l.rev,
        pending: this.pending.steps.join(", "),
      });
      return;
    }
    if (!this.closed) void this.report("crashed", null, l.child.lastError ?? `exit code ${code}`);
    log.warn("child exited unexpectedly; restarting on the next poll", { pid: l.child.pid, exit_code: code });
  }

  /** The lowest block of `size` worker indexes that no live child uses. */
  private freeBase(size: number): number {
    for (let b = 0; ; b++) {
      if (this.live.every((l) => b + size <= l.base || b >= l.base + l.size)) return b;
    }
  }

  /** `workers` from the folder's factory.config.json, the file its child reads. Absent or invalid: 1. */
  private async blockSize(dir: string): Promise<number> {
    try {
      const w = (JSON.parse(await readFile(join(dir, "factory.config.json"), "utf8")) as { workers?: unknown }).workers;
      return typeof w === "number" && Number.isInteger(w) && w >= 1 ? w : 1;
    } catch {
      return 1;
    }
  }

  /** Writes the status file (atomically: a temp file, then rename). A failure is logged, never thrown. */
  private async report(state: SupervisorStatus["state"], target: string | null, error: string | null = null): Promise<void> {
    const file = this.o.statusFile;
    if (!file) return;
    const last = this.lastStatus;
    const now = this.o.clock.now().toISOString();
    // A crash loop (crash, restart, the same crash) keeps the first crash's time; any other state ends it.
    if (state === "crashed") this.crash = this.crash?.error === error ? this.crash : { error, since: now };
    else if (state !== "running") this.crash = null;
    const waiting = state === "migration_pending" || state === "draining" ? this.pending : null;
    const status: SupervisorStatus = {
      state,
      rev: this.runningRev,
      target_rev: target,
      child_pid: state === "stopped" || state === "crashed" ? null : this.childPid(),
      draining_pids: state === "stopped" ? [] : this.live.filter((l) => l.draining).map((l) => l.child.pid),
      since: state === "crashed" ? this.crash!.since : last && last.state === state ? last.since : now,
      error,
      pending_steps: waiting?.steps ?? [],
      target_dir: waiting?.dir ?? null,
      supervisor_pid: state === "stopped" ? null : (this.o.supervisorPid ?? process.pid),
      held: this.held,
    };
    this.lastStatus = status;
    // One write at a time: a child's exit can report while a poll does.
    const write = async () => {
      try {
        await writeFile(`${file}.tmp`, `${JSON.stringify(status)}\n`);
        await rename(`${file}.tmp`, file);
      } catch (err) {
        this.o.log.warn("could not write the supervisor status", { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      }
    };
    this.reporting = this.reporting.then(write, write);
    await this.reporting;
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

  // --- folders ------------------------------------------------------------------------------------------

  /** A new detached worktree for `rev` under versions/. */
  private async create(rev: string): Promise<string> {
    const { repoPath } = this.o;
    const dir = await this.freshDir(rev);
    await mkdir(this.versionsDir, { recursive: true });
    await this.git(repoPath, ["worktree", "prune"]);
    await this.git(repoPath, ["worktree", "add", "--detach", dir, rev]);
    return dir;
  }

  /** `versions/<short-rev>`, or `-2`, `-3`... when that name is held by a folder that must stay. */
  private async freshDir(rev: string): Promise<string> {
    const short = rev.slice(0, 12);
    const held = (d: string) => d === this.newest || this.foreign.has(d) || this.live.some((l) => l.dir === d);
    for (let n = 1; ; n++) {
      const dir = join(this.versionsDir, n === 1 ? short : `${short}-${n}`);
      if (held(dir)) continue;
      if (existsSync(dir)) await this.removeFolder(dir);
      return dir;
    }
  }

  /**
   * Start: every folder under versions/ whose pid file is missing or names a dead process is removed, except
   * the newest built one when its build matches origin (a restart does not rebuild). A live pid keeps its folder.
   */
  private async sweep(origin: string): Promise<void> {
    const { log } = this.o;
    const dead: string[] = [];
    for (const dir of await this.folders()) {
      const pid = await this.readPid(dir);
      if (pid !== null && this.pidAlive(pid)) {
        this.foreign.add(dir);
        log.warn("a version folder is still used by a running process; kept", { dir, pid });
      } else dead.push(dir);
    }
    const newest = await this.newestBuilt(dead);
    if (newest && (await this.builtRev(newest)) === origin && (await this.head(newest).catch(() => null)) === origin) {
      this.newest = newest;
      log.info("reusing the newest folder: its build matches origin", { dir: newest, rev: origin });
    }
    for (const dir of dead) if (dir !== this.newest) await this.removeFolder(dir);
  }

  /** The drain-then-start layout's runtime/ and runtime-next/, removed once no foreign child is alive. */
  private async removeLegacy(): Promise<void> {
    for (const dir of [this.o.runtimeDir, this.o.stagingDir]) {
      if (!existsSync(dir)) continue;
      this.o.log.info("removing the legacy runtime folder", { dir });
      await this.removeFolder(dir);
    }
  }

  /**
   * Kept: folders with a live child (ours or foreign), the one building, and the newest folder (or, when it has a
   * live child, the newest built folder not already kept), plus any folder a kept folder links into. Everything
   * else under versions/ is removed, then every install under deps/ no kept folder links to.
   */
  private async cleanup(): Promise<void> {
    for (const dir of [...this.foreign]) {
      const pid = await this.readPid(dir);
      if (pid === null || !this.pidAlive(pid)) this.foreign.delete(dir);
    }
    const all = await this.folders();
    const kept = new Set<string>([...this.live.map((l) => l.dir), ...this.foreign]);
    if (this.building) kept.add(this.building);
    if (this.pending) kept.add(this.pending.dir);
    const extra = this.newest && !kept.has(this.newest) ? this.newest : await this.newestBuilt(all.filter((d) => !kept.has(d)));
    if (extra) kept.add(extra);
    const links = await Promise.all([...kept].map((d) => this.linkTarget(d)));
    for (const dir of all) {
      if (kept.has(dir)) continue;
      if (links.some((t) => t !== null && within(t, dir))) continue;
      await this.removeFolder(dir);
    }
    const used = new Set(links.filter((t): t is string => t !== null && within(t, this.depsDir)).map((t) => t.slice(this.depsDir.length + 1).split(sep)[0]!));
    const installs = await readdir(this.depsDir).catch(() => [] as string[]);
    for (const name of installs) {
      if (used.has(name)) continue;
      this.o.log.info("install removed: no kept folder links to it", { dir: join(this.depsDir, name) });
      await rm(join(this.depsDir, name), { recursive: true, force: true });
    }
  }

  /**
   * `git worktree remove --force`, then plain deletion if that failed or left the folder, then
   * `git worktree prune`, so `git worktree list` has no entry for it. A node_modules link is removed, not followed.
   */
  private async removeFolder(dir: string | null): Promise<void> {
    if (!dir) return;
    await removeWorktree(this.o.run, { repoPath: this.o.repoPath, env: this.o.env, signal: this.abort.signal }, dir);
    this.buildSeq.delete(dir);
    this.o.log.info("folder removed", { dir });
  }

  private async folders(): Promise<string[]> {
    const names = await readdir(this.versionsDir).catch(() => [] as string[]);
    return names.sort().map((n) => join(this.versionsDir, n));
  }

  /** The newest of `dirs` by build time: those built by this process first, then dist's marker mtime. */
  private async newestBuilt(dirs: readonly string[]): Promise<string | null> {
    let best: { dir: string; key: [number, bigint] } | null = null;
    for (const dir of dirs) {
      let key: [number, bigint];
      const seq = this.buildSeq.get(dir);
      if (seq !== undefined) key = [1, BigInt(seq)];
      else {
        const st = await stat(join(dir, "dist", BUILT_MARKER), { bigint: true }).catch(() => null);
        if (!st) continue;
        key = [0, st.mtimeNs];
      }
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { dir, key };
    }
    return best?.dir ?? null;
  }

  private async readPid(dir: string): Promise<number | null> {
    const s = await readFile(join(dir, PID_FILE), "utf8").catch(() => null);
    const pid = s === null ? Number.NaN : Number.parseInt(s.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  private pidAlive(pid: number): boolean {
    return (this.o.pidAlive ?? defaultPidAlive)(pid);
  }

  /** Where the folder's node_modules link points (absolute), or null. */
  private async linkTarget(dir: string): Promise<string | null> {
    const t = await readlink(join(dir, "node_modules")).catch(() => null);
    return t === null ? null : resolve(dir, t);
  }

  // --- build ---------------------------------------------------------------------------------------------

  /** Links node_modules to the install for the folder's lock file (installing it if new), then `npm run build`. */
  private async build(dir: string, rev: string): Promise<boolean> {
    await rm(join(dir, "dist", BUILT_MARKER), { force: true });
    if (!(await this.install(dir, rev))) return false;
    const r = await this.exec(dir, ["npm", "run", "build"]);
    if (r.exit_code !== 0) return this.buildFailed(rev, "npm run build", r);
    await writeFile(join(dir, "dist", BUILT_MARKER), rev);
    this.buildSeq.set(dir, ++this.seq);
    this.o.log.info("built", { rev, dir });
    return true;
  }

  /**
   * `deps/<hash of package-lock.json>/node_modules`, shared by every folder with that lock file. A new hash:
   * `npm ci` in the folder, then its node_modules moves into deps/ (through a temp name, so deps/ only ever
   * holds complete installs; a failed `npm ci` leaves nothing there). The folder's node_modules links to it.
   */
  private async install(dir: string, rev: string): Promise<boolean> {
    const lock = await readFile(join(dir, "package-lock.json")).catch(() => Buffer.alloc(0));
    const hash = createHash("sha256").update(lock).digest("hex").slice(0, 16);
    const dep = join(this.depsDir, hash);
    const modules = join(dir, "node_modules");
    if (!existsSync(join(dep, "node_modules"))) {
      await rm(modules, { recursive: true, force: true });
      const r = await this.exec(dir, ["npm", "ci"]);
      if (r.exit_code !== 0) {
        await rm(modules, { recursive: true, force: true });
        return this.buildFailed(rev, "npm ci", r);
      }
      const tmp = `${dep}.tmp`;
      await rm(tmp, { recursive: true, force: true });
      await rm(dep, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      await rename(modules, join(tmp, "node_modules"));
      await rename(tmp, dep);
      this.o.log.info("installed", { rev, lock_hash: hash });
    }
    await rm(modules, { recursive: true, force: true });
    await symlink(join(dep, "node_modules"), modules, "dir");
    return true;
  }

  private buildFailed(rev: string, step: string, r: ExecResult): false {
    this.o.log.error("build failed; the running child is untouched and this revision will not be started", {
      rev,
      step,
      exit_code: r.exit_code,
      output_tail: tail(`${r.stdout}${r.stderr}`),
    });
    return false;
  }

  private async builtRev(dir: string): Promise<string | null> {
    return readFile(join(dir, "dist", BUILT_MARKER), "utf8").then(
      (s) => s.trim(),
      () => null,
    );
  }

  // --- git -----------------------------------------------------------------------------------------------

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

  private exec(cwd: string, cmd: readonly string[], env: Readonly<Record<string, string>> = this.o.env, timeoutMs?: number): Promise<ExecResult> {
    return this.o.run(cmd, { cwd, env, signal: this.abort.signal, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) });
  }
}

/**
 * Removes one worktree folder: `git worktree remove --force <dir>` from the main checkout, deleting the folder
 * directly if that failed or left it behind, then `git worktree prune`. Never follows a node_modules link.
 */
export async function removeWorktree(
  run: CommandRunner,
  o: { repoPath: string; env: Readonly<Record<string, string>>; signal?: AbortSignal },
  dir: string,
): Promise<void> {
  const opts = { cwd: o.repoPath, env: o.env, ...(o.signal ? { signal: o.signal } : {}) };
  const r = await run(["git", "worktree", "remove", "--force", dir], opts);
  if (r.exit_code !== 0 || existsSync(dir)) await rm(dir, { recursive: true, force: true });
  const p = await run(["git", "worktree", "prune"], opts);
  if (p.exit_code !== 0) throw new Error(`git worktree prune failed (exit ${p.exit_code}): ${tail(p.stderr.trim(), 300)}`);
}
