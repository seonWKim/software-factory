import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_ROOT_ENV, Plugins, loadConfig } from "../src/compose.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { runProcess } from "../src/impl/process/run-process.js";
import { defaultSecretsFile } from "../src/impl/secrets/env-file-secret-store.js";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";
import { type GitWorktreeOptions, GitWorktreeUpdater, PID_FILE, removeWorktree } from "../src/impl/updater/git-worktree.js";
import { NoneUpdater } from "../src/impl/updater/none.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { type ChildHandle, type ChildLauncher, type ChildSpec, type CommandRunner, WORKER_INDEX_BASE_ENV } from "../src/interfaces/updater.js";
import { REGISTRY, createPlugin } from "../src/plugins.js";
import { SUPERVISED_ENV, createUpdater, supervise } from "../src/supervisor.js";
import { recordingLog, waitFor } from "./helpers/fakes.js";

// A fake git remote + checkout, fake npm, and a fake process launcher. Commands touch a real temp dir
// (worktree add creates the directory, npm ci writes node_modules/, build writes dist/), so the updater's
// folders, installs and links are real.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const RUNTIME = ".factory/runtime";
const STAGING = ".factory/runtime-next";
const DEPS = ".factory/deps";
/** The version folder for a revision. */
const V = (rev: string) => `.factory/versions/${rev}`;
const FORBIDDEN = new Set(["checkout", "stash", "reset", "switch", "branch", "restore", "clean"]);

const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
const fail = (stderr: string, code = 1): ExecResult => ({ exit_code: code, signal: null, stdout: "", stderr, timed_out: false });

class World {
  readonly root = mkdtempSync(join(tmpdir(), "sf-updater-"));
  /** Every command: "<dir relative to root>: <argv>". */
  calls: string[] = [];
  /** The ordered events the criteria talk about, across git, npm and the launcher. */
  events: string[] = [];
  /** Folders removed through `git worktree remove`, in order. */
  removed: string[] = [];
  commits = ["c1"];
  changed = new Map<string, string[]>([["c1", []]]);
  origin = "c1";
  heads = new Map<string, string>([[".", "c1"]]);
  mainBranch = "main";
  mainDirty = "";
  mainFfFails = false;
  failBuild = new Set<string>();
  failCi = new Set<string>();
  /** Pids of fake children that are alive, across launchers (the orphan sweep asks). */
  alive = new Set<number>();
  nextPid = 1;

  push(sha: string, files: string[]): void {
    this.commits.push(sha);
    this.changed.set(sha, files);
    this.origin = sha;
  }

  private diff(a: string, b: string): string[] {
    const from = this.commits.indexOf(a);
    const to = this.commits.indexOf(b);
    return [...new Set(this.commits.slice(from + 1, to + 1).flatMap((c) => this.changed.get(c) ?? []))];
  }

  /** The commit whose package-lock.json `rev` has: the last one at or before it that changed the file. */
  lockAt(rev: string): string {
    const upTo = this.commits.slice(0, this.commits.indexOf(rev) + 1);
    return upTo.filter((c) => (this.changed.get(c) ?? []).includes("package-lock.json")).at(-1) ?? "c1";
  }

  private resolveRef(ref: string): string {
    return ref === "origin/main" || ref === "refs/remotes/origin/main^{commit}" ? this.origin : ref;
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  run: CommandRunner = async (cmd, opts) => {
    const dir = relative(this.root, opts.cwd) || ".";
    this.calls.push(`${dir}: ${cmd.join(" ")}`);
    expect(opts.env.PATH, "commands run with baseEnv").toBeDefined();
    const [tool, sub, ...rest] = cmd;
    if (tool === "npm" && sub === "ci") {
      const rev = this.heads.get(dir) ?? "?";
      this.events.push(`ci ${dir}`);
      mkdirSync(join(opts.cwd, "node_modules"), { recursive: true });
      writeFileSync(join(opts.cwd, "node_modules", "lock-of"), this.lockAt(rev));
      if (this.failCi.has(rev)) return fail("npm ERR! network");
      return ok();
    }
    if (tool === "npm" && sub === "run" && rest[0] === "build") {
      const rev = this.heads.get(dir)!;
      this.events.push(`build ${dir}@${rev}`);
      expect(existsSync(join(opts.cwd, "node_modules", "lock-of")), "node_modules is linked before the build").toBe(true);
      if (this.failBuild.has(rev)) return { ...fail("", 2), stdout: `src/x.ts(1,1): error TS2322: boom at ${rev}\n` };
      mkdirSync(join(opts.cwd, "dist"), { recursive: true });
      writeFileSync(join(opts.cwd, "dist", "main.js"), `// built from ${rev}`);
      return ok();
    }
    if (tool !== "git") throw new Error(`unexpected command ${cmd.join(" ")}`);
    if (FORBIDDEN.has(sub!)) throw new Error(`forbidden git command: ${cmd.join(" ")}`);
    const args = rest.join(" ");
    switch (sub) {
      case "fetch":
        this.events.push("fetch");
        return ok();
      case "rev-parse":
        if (args === "HEAD") return this.heads.has(dir) ? ok(`${this.heads.get(dir)}\n`) : fail("not a git repository", 128);
        if (args === "--abbrev-ref HEAD") return ok(`${this.mainBranch}\n`);
        if (rest[0] === "--verify") return ok(`${this.resolveRef(rest[1]!)}\n`);
        break;
      case "status":
        return ok(this.mainDirty);
      case "worktree": {
        const path = rest[rest.length - (rest[0] === "add" ? 2 : 1)]!;
        const rel = relative(this.root, path);
        if (rest[0] === "add") {
          const sha = this.resolveRef(rest[rest.length - 1]!);
          this.events.push(`worktree add ${rel} ${sha}`);
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, ".git"), "gitdir: x");
          writeFileSync(join(path, "package-lock.json"), `lock@${this.lockAt(sha)}`);
          if (this.workers) writeFileSync(join(path, "factory.config.json"), JSON.stringify({ workers: this.workers }));
          this.heads.set(rel, sha);
          return ok();
        }
        if (rest[0] === "remove") {
          this.removed.push(rel);
          rmSync(path, { recursive: true, force: true });
          this.heads.delete(rel);
          return ok();
        }
        if (rest[0] === "prune") return ok();
        break;
      }
      case "diff":
        return ok(this.diff(rest[1]!, rest[2]!).join("\n"));
      case "merge-base":
        return this.commits.indexOf(rest[1]!) <= this.commits.indexOf(rest[2]!) ? ok() : fail("");
      case "merge": {
        const target = this.resolveRef(rest[rest.length - 1]!);
        if (dir === "." && this.mainFfFails) return fail("fatal: Not possible to fast-forward, aborting.");
        this.events.push(`ff ${dir} ${target}`);
        this.heads.set(dir, target);
        return ok();
      }
    }
    throw new Error(`unexpected git command ${cmd.join(" ")}`);
  };

  /** `workers` written into each new folder's factory.config.json; 0: no file (block size 1). */
  workers = 0;

  /** Folders under versions/. */
  versions(): string[] {
    const d = this.path(".factory/versions");
    return existsSync(d) ? readdirSync(d).sort() : [];
  }

  deps(): string[] {
    const d = this.path(DEPS);
    return existsSync(d) ? readdirSync(d).sort() : [];
  }
}

type DrainMode = "ack" | "hold" | "ignore";

class FakeChild implements ChildHandle {
  drainAcknowledged = false;
  lastError: string | null = null;
  readonly exited: Promise<number | null>;
  alive = true;
  kills: string[] = [];
  private resolveExit!: (code: number | null) => void;

  constructor(
    readonly pid: number,
    readonly spec: ChildSpec,
    private readonly world: World,
    public drainMode: DrainMode,
  ) {
    this.exited = new Promise((r) => (this.resolveExit = r));
    world.alive.add(pid);
  }
  requestDrain(): void {
    this.world.events.push(`drain ${this.pid}`);
    if (this.drainMode === "ack") queueMicrotask(() => this.finishDrain());
  }
  /** The worker's in-flight run is done: acknowledge and exit. */
  finishDrain(): void {
    this.drainAcknowledged = true;
    this.exit(0);
  }
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.world.events.push(`kill ${signal} ${this.pid}`);
    this.kills.push(signal);
    if (signal === "SIGKILL" || this.drainMode !== "ignore") this.exit(null);
  }
  exit(code: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.world.alive.delete(this.pid);
    this.world.events.push(`exit ${this.pid}`);
    this.resolveExit(code);
  }
}

class FakeLauncher implements ChildLauncher {
  children: FakeChild[] = [];
  drainMode: DrainMode = "ack";
  /** For each launch: the pids of this launcher's children alive at that moment (before the new one). */
  aliveAtLaunch: number[][] = [];
  constructor(private readonly world: World) {}
  launch(spec: ChildSpec): ChildHandle {
    this.aliveAtLaunch.push(this.live.map((c) => c.pid));
    const pid = this.world.nextPid++;
    const built = readFileSync(spec.entry, "utf8");
    this.world.events.push(`launch ${pid} ${relative(this.world.root, spec.entry)} (${built})`);
    const child = new FakeChild(pid, spec, this.world, this.drainMode);
    this.children.push(child);
    return child;
  }
  get live(): FakeChild[] {
    return this.children.filter((c) => c.alive);
  }
}

function setup(opts: { runTimeoutMs?: number; statusFile?: string; world?: World } = {}) {
  const world = opts.world ?? new World();
  const launcher = new FakeLauncher(world);
  const log = recordingLog();
  const clock = new FakeClock();
  const updater = new GitWorktreeUpdater({
    repoPath: world.root,
    runtimeDir: join(world.root, RUNTIME),
    stagingDir: join(world.root, STAGING),
    baseBranch: "main",
    run: world.run,
    launcher,
    clock,
    log,
    env: { PATH: "/usr/bin" },
    runTimeoutMs: opts.runTimeoutMs ?? 1000,
    pidAlive: (pid) => world.alive.has(pid),
    ...(opts.statusFile ? { statusFile: opts.statusFile } : {}),
  });
  return { world, launcher, log, clock, updater };
}

/** A second supervisor on the same state dir and world (the first one crashed or was restarted). */
function restart(a: { world: World; updater: GitWorktreeUpdater }) {
  const launcher = new FakeLauncher(a.world);
  const log = recordingLog();
  const again = new GitWorktreeUpdater({ ...(a.updater as unknown as { o: GitWorktreeOptions }).o, launcher, log });
  return { launcher, log, updater: again };
}

const noForbidden = (world: World) => {
  for (const c of world.calls) {
    const argv = c.split(": ")[1]!.split(" ");
    if (argv[0] === "git") expect(FORBIDDEN.has(argv[1]!), c).toBe(false);
  }
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A temp main checkout with its own config and prompts. */
function checkout(config: Record<string, unknown>, tag: string, dir = mkdtempSync(join(tmpdir(), "sf-root-"))): string {
  mkdirSync(join(dir, "prompts"), { recursive: true });
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), `${tag} ${p}`);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, intake_label: `${tag}-label` }));
  return dir;
}

describe("updater: none", () => {
  it("runs dev in place: zero git or process calls", async () => {
    const world = new World();
    const launcher = new FakeLauncher(world);
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(world.root, "secrets.env"));
    const root = checkout({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), updater: "none" } }, "main");
    const loaded = await loadConfig(root);
    expect(loaded.plugins.updater).toBe("none");
    const clock = new FakeClock();
    const updater = await createUpdater(loaded, { run: world.run, launcher, clock, log: recordingLog() });
    expect(updater).toBeInstanceOf(NoneUpdater);
    let inPlace = 0;
    const code = await supervise({
      updater,
      clock,
      pollMs: 1000,
      log: recordingLog(),
      signals: { once() {} },
      inPlace: async () => void inPlace++,
    });
    expect(code).toBe(0);
    expect(inPlace).toBe(1);
    expect(world.calls).toEqual([]);
    expect(launcher.children).toEqual([]);
  });
});

describe("updater: code root and state root", () => {
  it("config and prompts come from the runtime copy; everything stateful from the main checkout", async () => {
    const config = { ...REAL, store: { type: "sqlite" } };
    const main = checkout(config, "main");
    const runtime = checkout(config, "runtime", join(main, ".factory", "versions", "c1"));
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(main, "elsewhere", ".env"));

    const loaded = await loadConfig(main, { codeRoot: runtime });
    expect(loaded.file.intake_label).toBe("runtime-label");
    expect(loaded.config.intake_label).toBe("runtime-label");
    expect(loaded.prompts).toEqual({
      triage: "runtime triage", implement: "runtime implement", review: "runtime review", resolve: "runtime resolve",
    });

    expect(loaded.root).toBe(main);
    expect(loaded.stateDir).toBe(join(main, ".factory"));
    expect(loaded.config.repo.path).toBe(main);
    expect(loaded.secretsFile).toBe(defaultSecretsFile());
    expect(loaded.config.deny_paths).toContain(join(main, ".factory", "db"));
    expect(loaded.config.deny_paths).toContain(join(main, ".factory", "storage"));

    const base = new Plugins(loaded).base;
    const sandbox = await createPlugin(REGISTRY, "sandbox", "noop", base);
    expect((sandbox as unknown as { worktreesDir: string }).worktreesDir).toBe(join(main, ".worktrees"));
    const storage = await createPlugin(REGISTRY, "storage", "fs", base);
    expect(storage).toBeInstanceOf(FsSharedStorage);
    expect((storage as unknown as { root: string }).root).toBe(join(main, ".factory", "storage"));
    mkdirSync(join(main, ".factory", "db"), { recursive: true });
    const store = await createPlugin(REGISTRY, "store", "sqlite", { ...base, secrets: null as never, clock: new FakeClock() });
    await store.close();
    expect(existsSync(join(main, ".factory", "db", "factory.db"))).toBe(true);
    expect(existsSync(join(runtime, ".factory"))).toBe(false);
  });

  it("without a code root, both are the same directory (today's behaviour)", async () => {
    const main = checkout({ ...REAL, store: { type: "sqlite" } }, "main");
    const loaded = await loadConfig(main);
    expect(loaded.root).toBe(main);
    expect(loaded.prompts.triage).toBe("main triage");
  });

  it("the resolve prompt is read from prompts/resolve.md; without the file it is absent and loading still succeeds", async () => {
    const main = checkout({ ...REAL, store: { type: "sqlite" } }, "main");
    expect((await loadConfig(main)).prompts.resolve).toBe("main resolve");
    rmSync(join(main, "prompts", "resolve.md"));
    expect((await loadConfig(main)).prompts.resolve).toBeUndefined();
  });

  it("repo.install_command defaults to [\"npm\",\"ci\"], the checked-in config sets it, and a bad value fails startup", async () => {
    expect((REAL.repo as Record<string, unknown>).install_command).toEqual(["npm", "ci"]);
    const { install_command: _, ...repo } = REAL.repo as Record<string, unknown>;
    const absent = checkout({ ...REAL, repo, store: { type: "sqlite" } }, "main");
    expect((await loadConfig(absent)).config.repo.install_command).toEqual(["npm", "ci"]);
    const set = checkout({ ...REAL, repo: { ...repo, install_command: ["pnpm", "install"] }, store: { type: "sqlite" } }, "main");
    expect((await loadConfig(set)).config.repo.install_command).toEqual(["pnpm", "install"]);
    const bad = checkout({ ...REAL, repo: { ...repo, install_command: "npm ci" }, store: { type: "sqlite" } }, "main");
    await expect(loadConfig(bad)).rejects.toThrow(/repo\.install_command/);
  });

  it("the registry wires git-worktree to the main checkout; versions/ and deps/ sit in the state dir beside the legacy runtime/", async () => {
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", "/nonexistent/.env");
    const main = checkout({ ...REAL, store: { type: "sqlite" } }, "main");
    const loaded = await loadConfig(main);
    expect(loaded.plugins.updater).toBe("git-worktree");
    const world = new World();
    const u = await createUpdater(loaded, { run: world.run, launcher: new FakeLauncher(world), clock: new FakeClock(), log: recordingLog() });
    expect(u).toBeInstanceOf(GitWorktreeUpdater);
    const o = (u as unknown as { o: { repoPath: string; runtimeDir: string; baseBranch: string } }).o;
    expect(o).toMatchObject({ repoPath: main, runtimeDir: join(main, ".factory", "runtime"), baseBranch: "main" });
    const dirs = u as unknown as { versionsDir: string; depsDir: string };
    expect(dirs.versionsDir).toBe(join(main, ".factory", "versions"));
    expect(dirs.depsDir).toBe(join(main, ".factory", "deps"));
  });
});

describe("updater: git-worktree first start", () => {
  it("creates versions/<short-rev> detached at origin/<base>, installs, builds, starts the child from its dist", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    expect(world.events).toEqual([
      "fetch",
      `worktree add ${V("c1")} c1`,
      `ci ${V("c1")}`,
      `build ${V("c1")}@c1`,
      `launch 1 ${V("c1")}/dist/main.js (// built from c1)`,
    ]);
    expect(world.calls).toContain(`.: git worktree add --detach ${world.path(V("c1"))} c1`);
    const spec = launcher.children[0]!.spec;
    expect(spec.cwd).toBe(world.root);
    expect(spec.args).toEqual(["dev"]);
    expect(spec.env[CODE_ROOT_ENV]).toBe(world.path(V("c1")));
    expect(spec.env[SUPERVISED_ENV]).toBe("1");
    expect(spec.env[WORKER_INDEX_BASE_ENV]).toBe("0");
    expect(updater.childPid()).toBe(1);
    noForbidden(world);
  });

  it("writes the child's pid to .factory-pid in its folder", async () => {
    const { world, updater } = setup();
    await updater.start();
    expect(readFileSync(world.path(`${V("c1")}/${PID_FILE}`), "utf8").trim()).toBe("1");
  });

  it("node_modules is a link to deps/<lock hash>/node_modules, where the npm ci output was moved", async () => {
    const { world, updater } = setup();
    await updater.start();
    const link = world.path(`${V("c1")}/node_modules`);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const [hash] = world.deps();
    expect(world.deps()).toHaveLength(1);
    expect(realpathSync(link)).toBe(realpathSync(world.path(`${DEPS}/${hash}/node_modules`)));
    expect(readFileSync(join(link, "lock-of"), "utf8")).toBe("c1");
  });

  it("a restart reuses the newest folder when its build matches origin: no rebuild", async () => {
    const a = setup();
    await a.updater.start();
    await a.updater.shutdown();
    const b = restart(a);
    a.world.events = [];
    await b.updater.start();
    expect(a.world.events).toEqual(["fetch", `launch 2 ${V("c1")}/dist/main.js (// built from c1)`]);
    expect(a.world.removed).toEqual([]);
  });

  it("a restart after origin moved removes the stale folder and builds the new one; a failed build starts nothing", async () => {
    const a = setup();
    await a.updater.start();
    await a.updater.shutdown();
    a.world.push("c2", ["src/core/worker.ts"]);
    a.world.failBuild.add("c2");
    const b = restart(a);
    a.world.events = [];
    await b.updater.start();
    expect(a.world.events).toEqual(["fetch", "ff . c2", `worktree add ${V("c2")} c2`, `build ${V("c2")}@c2`]);
    expect(a.world.removed).toEqual([V("c1")]);
    expect(b.launcher.children).toEqual([]);
  });
});

describe("updater: git-worktree start-then-drain", () => {
  const CODE = ["src/core/worker.ts", "prompts/review.md", "package.json", "package-lock.json", "tsconfig.test.json", "factory.config.json"];
  for (const file of CODE) {
    it(`${file}: fetch, build in a new folder, start the new child, then drain the old one`, async () => {
      const { world, launcher, updater } = setup();
      await updater.start();
      world.events = [];
      world.push("c2", [file, "docs/design.md"]);
      await updater.poll();
      await settle();
      const ci = file === "package-lock.json" ? [`ci ${V("c2")}`] : [];
      expect(world.events).toEqual([
        "fetch",
        "ff . c2",
        `worktree add ${V("c2")} c2`,
        ...ci,
        `build ${V("c2")}@c2`,
        `launch 2 ${V("c2")}/dist/main.js (// built from c2)`,
        "drain 1",
        "exit 1",
      ]);
      expect(launcher.children[0]!.drainAcknowledged).toBe(true);
      expect(launcher.live.map((c) => c.pid)).toEqual([2]);
      noForbidden(world);
    });
  }

  it("the new child is launched while the old one is alive; poll returns without waiting for it", async () => {
    const { world, launcher, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll(); // resolves although child 1 never exits
    expect(launcher.aliveAtLaunch[1]).toEqual([1]);
    expect(launcher.children[0]!.alive).toBe(true);
    expect(world.events.indexOf("launch 2 .factory/versions/c2/dist/main.js (// built from c2)")).toBeLessThan(world.events.indexOf("drain 1"));
    expect(updater.childPid()).toBe(2);
    expect(updater.childPids()).toEqual([1, 2]);
  });

  it("a normal drain sends no SIGTERM or SIGKILL; the old child exits only after its last run finishes", async () => {
    const { world, launcher, log, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll();
    await settle();
    expect(launcher.children[0]!.alive).toBe(true); // its in-flight run is still going
    launcher.children[0]!.finishDrain();
    await settle();
    expect(world.events.slice(world.events.indexOf("drain 1"))).toEqual(["drain 1", "exit 1"]);
    expect(launcher.children[0]!.kills).toEqual([]);
    expect(launcher.children[1]!.kills).toEqual([]);
    // Exiting while draining is not a crash.
    expect(log.lines.some((l) => /exited unexpectedly/.test(l.msg))).toBe(false);
    expect(log.lines.find((l) => /drained and exited/.test(l.msg))?.fields).toMatchObject({ pid: 1, acknowledged: true });
    expect(updater.childPid()).toBe(2);
  });

  it("the old child's entry and CODE_ROOT still point at its own folder, which stays on disk while it runs", async () => {
    const { world, launcher, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll();
    const [old, neu] = launcher.children;
    expect(old!.spec.entry).toBe(world.path(`${V("c1")}/dist/main.js`));
    expect(old!.spec.env[CODE_ROOT_ENV]).toBe(world.path(V("c1")));
    expect(neu!.spec.env[CODE_ROOT_ENV]).toBe(world.path(V("c2")));
    expect(readFileSync(old!.spec.entry, "utf8")).toBe("// built from c1");
    expect(world.heads.get(V("c1"))).toBe("c1");
  });

  it("a crashed new child is restarted from its own folder on the next poll", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll();
    launcher.children[1]!.exit(1);
    await settle();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", `launch 3 ${V("c2")}/dist/main.js (// built from c2)`]);
    expect(launcher.children[2]!.spec.env[CODE_ROOT_ENV]).toBe(world.path(V("c2")));
  });

  it("a poll with no new commit does nothing but fetch", async () => {
    const { world, updater } = setup();
    await updater.start();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch"]);
  });
});

describe("updater: git-worktree installs", () => {
  it("npm ci runs in the new folder only when the lock file changed; the old folder keeps its own install", async () => {
    const { world, launcher, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    world.push("c2", ["package-lock.json"]);
    world.events = [];
    await updater.poll();
    expect(world.events.filter((e) => e.startsWith("ci "))).toEqual([`ci ${V("c2")}`]);
    expect(world.deps()).toHaveLength(2);
    expect(readFileSync(world.path(`${V("c1")}/node_modules/lock-of`), "utf8")).toBe("c1");
    expect(readFileSync(world.path(`${V("c2")}/node_modules/lock-of`), "utf8")).toBe("c2");
    expect(realpathSync(world.path(`${V("c1")}/node_modules`))).not.toBe(realpathSync(world.path(`${V("c2")}/node_modules`)));

    world.push("c3", ["src/b.ts"]);
    world.events = [];
    await updater.poll();
    expect(world.events.filter((e) => e.startsWith("ci "))).toEqual([]);
    expect(realpathSync(world.path(`${V("c3")}/node_modules`))).toBe(realpathSync(world.path(`${V("c2")}/node_modules`)));
  });

  it("an install is removed only when no kept folder links to it", async () => {
    const { world, launcher, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    const first = world.deps()[0]!;
    world.push("c2", ["package-lock.json"]);
    await updater.poll();
    launcher.children[0]!.finishDrain();
    await settle();
    await updater.poll();
    // c1 has no child but is the newest built folder not otherwise kept: it and its install stay.
    expect(world.versions()).toEqual(["c1", "c2"]);
    expect(world.deps()).toContain(first);

    launcher.drainMode = "ack";
    world.push("c3", ["src/b.ts"]);
    await updater.poll();
    launcher.children[1]!.finishDrain();
    await settle();
    await updater.poll();
    expect(world.versions()).toEqual(["c2", "c3"]);
    expect(world.deps()).not.toContain(first);
    expect(world.deps()).toHaveLength(1);
  });

  it("a failed npm ci leaves no entry in deps/, and the next attempt starts clean", async () => {
    const { world, log, launcher, updater } = setup();
    await updater.start();
    const before = world.deps();
    world.push("c2", ["package-lock.json"]);
    world.failCi.add("c2");
    await updater.poll();
    expect(world.deps()).toEqual(before);
    expect(world.versions()).toEqual(["c1"]);
    expect(launcher.children[0]!.alive).toBe(true);
    expect(log.lines.find((l) => /build failed/.test(l.msg))?.fields).toMatchObject({ rev: "c2", step: "npm ci" });

    world.push("c3", ["package-lock.json"]);
    world.events = [];
    await updater.poll();
    expect(world.events).toContain(`ci ${V("c3")}`);
    expect(world.deps()).toHaveLength(2);
    expect(world.deps().some((d) => d.endsWith(".tmp"))).toBe(false);
  });
});

describe("updater: git-worktree status file", () => {
  it("reports running, then running on the new revision with the old child draining; stopped on shutdown", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-status-")), "supervisor.json");
    const read = () =>
      JSON.parse(readFileSync(file, "utf8")) as { state: string; rev: string | null; target_rev: string | null; child_pid: number | null; draining_pids: number[] };
    const { world, launcher, updater } = setup({ statusFile: file });
    await updater.start();
    expect(read()).toMatchObject({ state: "running", rev: "c1", target_rev: null, child_pid: 1 });

    launcher.drainMode = "hold";
    launcher.children[0]!.drainMode = "hold";
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll();
    expect(read()).toMatchObject({ state: "running", rev: "c2", target_rev: null, child_pid: 2, draining_pids: [1] });
    launcher.children[0]!.finishDrain();
    await waitFor(() => read().draining_pids.length === 0, "drain done");
    expect(read()).toMatchObject({ state: "running", rev: "c2", child_pid: 2 });

    await updater.shutdown();
    expect(read()).toMatchObject({ state: "stopped", child_pid: null });
  });

  it("a child that exits on its own is crashed with its error; repeated crashes keep the first time", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-status-")), "supervisor.json");
    const read = () => JSON.parse(readFileSync(file, "utf8")) as { state: string; error: string | null; since: string; child_pid: number | null };
    const { launcher, clock, updater } = setup({ statusFile: file });
    await updater.start();
    const pending = "1 schema step pending (state none, latest 11): run `npm run migrate`";
    const crash = async (i: number) => {
      launcher.children[i]!.lastError = pending;
      launcher.children[i]!.exit(1);
      await waitFor(() => read().state === "crashed", "crashed status");
    };
    await crash(0);
    const first = read();
    expect(first).toMatchObject({ state: "crashed", error: pending, child_pid: null });

    clock.advance(30_000);
    await updater.poll(); // restarts the child, which fails the same way
    expect(read().state).toBe("running");
    await crash(1);
    expect(read()).toMatchObject({ state: "crashed", error: pending, since: first.since });

    clock.advance(30_000);
    await updater.poll();
    launcher.children[2]!.exit(1);
    await waitFor(() => read().error === "exit code 1", "exit code error");
    await updater.shutdown();
  });
});

describe("updater: git-worktree docs-only change", () => {
  it("fast-forwards the newest folder without draining, killing or restarting the child", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    world.events = [];
    world.push("c2", ["docs/design.md", "README.md", "SET_UP.md"]);
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c2", `ff ${V("c1")} c2`]);
    expect(updater.childPid()).toBe(1);
    expect(launcher.children).toHaveLength(1);
    expect(launcher.children[0]!.kills).toEqual([]);

    // The docs-only revision counts as built: a crash restarts it without a build.
    launcher.children[0]!.exit(1);
    await settle();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", `launch 2 ${V("c1")}/dist/main.js (// built from c1)`]);
  });

  it("moves only the newest folder: an older live folder is not moved", async () => {
    const { world, launcher, updater } = setup();
    launcher.drainMode = "hold";
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    await updater.poll();
    world.push("c3", ["docs/design.md"]);
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c3", `ff ${V("c2")} c3`]);
    expect(world.heads.get(V("c1"))).toBe("c1");
    expect(launcher.children[0]!.alive).toBe(true);
  });
});

describe("updater: git-worktree failed build", () => {
  it("starts, drains and kills nothing, removes the failed folder at once, and retries on the next change", async () => {
    const { world, launcher, log, updater } = setup();
    await updater.start();
    world.events = [];
    world.push("c2", ["src/core/worker.ts"]);
    world.failBuild.add("c2");
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c2", `worktree add ${V("c2")} c2`, `build ${V("c2")}@c2`]);
    expect(world.versions()).toEqual(["c1"]);
    expect(world.removed).toEqual([V("c2")]);
    expect(updater.childPid()).toBe(1);
    expect(launcher.children).toHaveLength(1);
    expect(launcher.children[0]!.kills).toEqual([]);
    const line = log.lines.find((l) => l.level === "error" && /build failed/.test(l.msg));
    expect(line?.fields).toMatchObject({ rev: "c2", step: "npm run build", exit_code: 2 });
    expect(String(line?.fields?.output_tail)).toContain("error TS2322: boom at c2");

    // Same commit: not built again.
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch"]);

    // The next change builds and starts.
    world.push("c3", ["src/core/worker.ts"]);
    world.events = [];
    await updater.poll();
    await settle();
    expect(world.events).toEqual([
      "fetch",
      "ff . c3",
      `worktree add ${V("c3")} c3`,
      `build ${V("c3")}@c3`,
      `launch 2 ${V("c3")}/dist/main.js (// built from c3)`,
      "drain 1",
      "exit 1",
    ]);
  });

  it("after a crash, the restart runs the last folder that built, never the failed one", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    world.failBuild.add("c2");
    await updater.poll();
    launcher.children[0]!.exit(1);
    await settle();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", `launch 2 ${V("c1")}/dist/main.js (// built from c1)`]);
    expect(world.heads.get(V("c1"))).toBe("c1");
  });

  it("a first start whose build fails starts nothing, and does not rebuild the same tree on every poll", async () => {
    const { world, launcher, updater } = setup();
    world.failBuild.add("c1");
    await updater.start();
    expect(launcher.children).toEqual([]);
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch"]);
    expect(launcher.children).toEqual([]);

    world.push("c2", ["src/core/worker.ts"]);
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c2", `worktree add ${V("c2")} c2`, `build ${V("c2")}@c2`, `launch 1 ${V("c2")}/dist/main.js (// built from c2)`]);
    expect(world.versions()).toEqual(["c2"]);
  });
});

describe("updater: git-worktree cleanup", () => {
  it("three quick merges in a row: the folder count stays within live children plus one", async () => {
    for (const mode of ["ack", "hold"] as const) {
      const { world, launcher, updater } = setup();
      launcher.drainMode = mode;
      await updater.start();
      for (const rev of ["c2", "c3", "c4"]) {
        world.push(rev, ["src/core/worker.ts"]);
        await updater.poll();
        expect(world.versions().length, `${mode} ${rev}`).toBeLessThanOrEqual(launcher.live.length + 1);
      }
      for (const c of launcher.children.slice(0, -1)) c.finishDrain();
      await settle();
      await updater.poll();
      expect(world.versions(), mode).toEqual(["c3", "c4"]);
    }
  });

  it("orphan sweep on start: dead folders removed, a folder used by a live process kept, the newest reused", async () => {
    const a = setup();
    a.launcher.drainMode = "hold";
    await a.updater.start();
    a.world.push("c2", ["src/core/worker.ts"]);
    await a.updater.poll();
    // The supervisor crashes: child 1 (draining) survives, child 2 dies with it; an older orphan is left over.
    a.launcher.children[1]!.exit(null);
    mkdirSync(a.world.path(V("c0")), { recursive: true });
    writeFileSync(a.world.path(`${V("c0")}/${PID_FILE}`), "99\n");
    expect(a.world.versions()).toEqual(["c0", "c1", "c2"]);

    const b = restart(a);
    a.world.events = [];
    a.world.removed = [];
    await b.updater.start();
    expect(a.world.removed).toEqual([V("c0")]);
    expect(a.world.versions()).toEqual(["c1", "c2"]); // c1: pid 1 alive; c2: newest, built at origin
    expect(a.world.events).toEqual(["fetch", `launch 3 ${V("c2")}/dist/main.js (// built from c2)`]);
    expect(b.log.lines.some((l) => /still used by a running process/.test(l.msg) && l.fields?.pid === 1)).toBe(true);

    // While pid 1 lives, later polls keep its folder too.
    a.world.push("c3", ["src/core/worker.ts"]);
    b.launcher.drainMode = "ack";
    b.launcher.children[0]!.drainMode = "ack";
    await b.updater.poll();
    await settle();
    await b.updater.poll();
    expect(a.world.versions()).toContain("c1");
    a.launcher.children[0]!.exit(0);
    await b.updater.poll();
    expect(a.world.versions()).toEqual(["c2", "c3"]);
  });

  it("first start under the new layout removes the legacy runtime/ and runtime-next/ through git worktree remove", async () => {
    const { world, updater } = setup();
    for (const d of [RUNTIME, STAGING]) {
      mkdirSync(world.path(d), { recursive: true });
      writeFileSync(world.path(`${d}/.git`), "gitdir: x");
    }
    await updater.start();
    expect(world.removed).toEqual([RUNTIME, STAGING]);
    expect(world.calls).toContain(`.: git worktree remove --force ${world.path(RUNTIME)}`);
    expect(existsSync(world.path(RUNTIME))).toBe(false);
    expect(existsSync(world.path(STAGING))).toBe(false);
  });

  it("the legacy folders wait while the sweep finds a live child", async () => {
    const world = new World();
    mkdirSync(world.path(RUNTIME), { recursive: true });
    mkdirSync(world.path(V("c0")), { recursive: true });
    writeFileSync(world.path(`${V("c0")}/${PID_FILE}`), "4242\n");
    world.alive.add(4242);
    const { updater } = setup({ world });
    await updater.start();
    expect(existsSync(world.path(RUNTIME))).toBe(true);
    expect(world.versions()).toContain("c0");
  });

  it("removal through a real git repository: git worktree list has no entry, and the linked install survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-gitrm-"));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "a");
    const dir = join(root, ".factory", "versions", "abc");
    git("worktree", "add", "-q", "--detach", dir, "HEAD");
    const install = join(root, ".factory", "deps", "h1", "node_modules");
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, "keep"), "x");
    execFileSync("ln", ["-s", install, join(dir, "node_modules")]);
    writeFileSync(join(dir, PID_FILE), "1\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "main.js"), "");
    expect(git("worktree", "list", "--porcelain")).toContain(dir);

    await removeWorktree(runProcess, { repoPath: root, env }, dir);
    expect(existsSync(dir)).toBe(false);
    expect(git("worktree", "list", "--porcelain")).not.toContain("versions/abc");
    expect(readFileSync(join(install, "keep"), "utf8")).toBe("x");

    // A folder git no longer knows (its admin entry gone): plain deletion, then prune.
    const stray = join(root, ".factory", "versions", "stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, ".git"), "gitdir: /nonexistent");
    await removeWorktree(runProcess, { repoPath: root, env }, stray);
    expect(existsSync(stray)).toBe(false);
  });
});

describe("updater: the main checkout", () => {
  it("is fast-forwarded when on the base branch and clean", async () => {
    const { world, updater } = setup();
    await updater.start();
    world.push("c2", ["docs/x.md"]);
    await updater.poll();
    expect(world.calls).toContain(".: git merge --ff-only --quiet origin/main");
    expect(world.heads.get(".")).toBe("c2");
    noForbidden(world);
  });

  const skips: [string, (w: World) => void, RegExp][] = [
    ["not on the base branch", (w) => (w.mainBranch = "feature/x"), /not on base/],
    ["dirty", (w) => (w.mainDirty = " M src/main.ts\n"), /dirty/],
    ["fast-forward fails", (w) => (w.mainFfFails = true), /ff failed/],
  ];
  for (const [label, arrange, reason] of skips) {
    it(`is skipped with a log line when ${label}`, async () => {
      const { world, log, updater } = setup();
      arrange(world);
      await updater.start();
      world.push("c2", ["docs/x.md"]);
      await updater.poll();
      expect(world.heads.get(".")).toBe("c1");
      const lines = log.lines.filter((l) => /main checkout not fast-forwarded/.test(l.msg));
      expect(lines.length).toBeGreaterThan(0);
      expect(String(lines[0]!.fields?.reason)).toMatch(reason);
      if (label !== "fast-forward fails") expect(world.calls.some((c) => c.includes("merge --ff-only --quiet origin/main"))).toBe(false);
      noForbidden(world);
    });
  }
});
