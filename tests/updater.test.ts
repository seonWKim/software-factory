import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_ROOT_ENV, Plugins, loadConfig } from "../src/compose.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { defaultSecretsFile } from "../src/impl/secrets/env-file-secret-store.js";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";
import { type GitWorktreeOptions, GitWorktreeUpdater } from "../src/impl/updater/git-worktree.js";
import { NoneUpdater } from "../src/impl/updater/none.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import type { ChildHandle, ChildLauncher, ChildSpec, CommandRunner } from "../src/interfaces/updater.js";
import { REGISTRY, createPlugin } from "../src/plugins.js";
import { SUPERVISED_ENV, createUpdater, supervise } from "../src/supervisor.js";
import { recordingLog, waitFor } from "./helpers/fakes.js";

// A fake git remote + checkout, fake npm, and a fake process launcher. Commands touch a real temp dir
// (worktree add creates the directory, build writes dist/), so the updater's file moves are real.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const RUNTIME = ".factory/runtime";
const STAGING = ".factory/runtime-next";
const FORBIDDEN = new Set(["checkout", "stash", "reset", "switch", "branch", "restore", "clean"]);

const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
const fail = (stderr: string, code = 1): ExecResult => ({ exit_code: code, signal: null, stdout: "", stderr, timed_out: false });

class World {
  readonly root = mkdtempSync(join(tmpdir(), "sf-updater-"));
  /** Every command: "<dir relative to root>: <argv>". */
  calls: string[] = [];
  /** The ordered events the criteria talk about, across git, npm and the launcher. */
  events: string[] = [];
  commits = ["c1"];
  changed = new Map<string, string[]>([["c1", []]]);
  origin = "c1";
  heads = new Map<string, string>([[".", "c1"]]);
  mainBranch = "main";
  mainDirty = "";
  mainFfFails = false;
  failBuild = new Set<string>();

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

  private resolveRef(ref: string): string {
    return ref === "origin/main" || ref === "refs/remotes/origin/main^{commit}" ? this.origin : ref;
  }

  run: CommandRunner = async (cmd, opts) => {
    const dir = relative(this.root, opts.cwd) || ".";
    this.calls.push(`${dir}: ${cmd.join(" ")}`);
    expect(opts.env.PATH, "commands run with baseEnv").toBeDefined();
    const [tool, sub, ...rest] = cmd;
    if (tool === "npm" && sub === "ci") {
      this.events.push(`ci ${dir}`);
      mkdirSync(join(opts.cwd, "node_modules"), { recursive: true });
      writeFileSync(join(opts.cwd, "node_modules", "lock-of"), this.heads.get(dir) ?? "?");
      return ok();
    }
    if (tool === "npm" && sub === "run" && rest[0] === "build") {
      const rev = this.heads.get(dir)!;
      this.events.push(`build ${dir}@${rev}`);
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
        if (args === "HEAD") return ok(`${this.heads.get(dir)}\n`);
        if (args === "--abbrev-ref HEAD") return ok(`${this.mainBranch}\n`);
        if (rest[0] === "--verify") return ok(`${this.resolveRef(rest[1]!)}\n`);
        break;
      case "status":
        return ok(this.mainDirty);
      case "worktree": {
        const path = rest[rest.length - (rest[0] === "add" ? 2 : 1)]!;
        const rel = relative(this.root, path);
        if (rest[0] === "add") {
          const sha = rest[rest.length - 1]!;
          this.events.push(`worktree add ${rel} ${sha}`);
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, ".git"), "gitdir: x");
          this.heads.set(rel, this.resolveRef(sha));
          return ok();
        }
        if (rest[0] === "remove") {
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
}

type DrainMode = "ack" | "hold" | "ignore";

class FakeChild implements ChildHandle {
  drainAcknowledged = false;
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
    this.world.events.push(`exit ${this.pid}`);
    this.resolveExit(code);
  }
}

class FakeLauncher implements ChildLauncher {
  children: FakeChild[] = [];
  drainMode: DrainMode = "ack";
  constructor(private readonly world: World) {}
  launch(spec: ChildSpec): ChildHandle {
    const pid = this.children.length + 1;
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

function setup(opts: { runTimeoutMs?: number; statusFile?: string } = {}) {
  const world = new World();
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
    ...(opts.statusFile ? { statusFile: opts.statusFile } : {}),
  });
  return { world, launcher, log, clock, updater };
}

const noForbidden = (world: World) => {
  for (const c of world.calls) {
    const argv = c.split(": ")[1]!.split(" ");
    if (argv[0] === "git") expect(FORBIDDEN.has(argv[1]!), c).toBe(false);
  }
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
    const runtime = checkout(config, "runtime", join(main, ".factory", "runtime"));
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

  it("the registry wires git-worktree to <state_dir>/runtime and the main checkout", async () => {
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", "/nonexistent/.env");
    const main = checkout({ ...REAL, store: { type: "sqlite" } }, "main");
    const loaded = await loadConfig(main);
    expect(loaded.plugins.updater).toBe("git-worktree");
    const world = new World();
    const u = await createUpdater(loaded, { run: world.run, launcher: new FakeLauncher(world), clock: new FakeClock(), log: recordingLog() });
    expect(u).toBeInstanceOf(GitWorktreeUpdater);
    const o = (u as unknown as { o: { repoPath: string; runtimeDir: string; baseBranch: string } }).o;
    expect(o).toMatchObject({ repoPath: main, runtimeDir: join(main, ".factory", "runtime"), baseBranch: "main" });
  });
});

describe("updater: git-worktree first start", () => {
  it("creates .factory/runtime detached at origin/<base>, installs, builds, starts the child from its dist", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    expect(world.events).toEqual([
      "fetch",
      `worktree add ${RUNTIME} c1`,
      `ci ${RUNTIME}`,
      `build ${RUNTIME}@c1`,
      `launch 1 ${RUNTIME}/dist/main.js (// built from c1)`,
    ]);
    expect(world.calls).toContain(`.: git worktree add --detach ${join(world.root, RUNTIME)} c1`);
    const spec = launcher.children[0]!.spec;
    expect(spec.cwd).toBe(world.root);
    expect(spec.args).toEqual(["dev"]);
    expect(spec.env[CODE_ROOT_ENV]).toBe(join(world.root, RUNTIME));
    expect(spec.env[SUPERVISED_ENV]).toBe("1");
    expect(updater.childPid()).toBe(1);
    noForbidden(world);
  });

  it("a second start reuses the built runtime copy", async () => {
    const a = setup();
    await a.updater.start();
    await a.updater.shutdown();
    const launcher = new FakeLauncher(a.world);
    const again = new GitWorktreeUpdater({ ...(a.updater as unknown as { o: GitWorktreeOptions }).o, launcher });
    a.world.events = [];
    await again.start();
    expect(a.world.events).toEqual(["fetch", `launch 1 ${RUNTIME}/dist/main.js (// built from c1)`]);
  });
});

describe("updater: git-worktree code change", () => {
  const CODE = ["src/core/worker.ts", "prompts/review.md", "package.json", "package-lock.json", "tsconfig.test.json", "factory.config.json"];
  for (const file of CODE) {
    it(`${file}: fetch, build new revision, drain, exit, fast-forward, restart`, async () => {
      const { world, launcher, updater } = setup();
      await updater.start();
      world.events = [];
      world.push("c2", [file, "docs/design.md"]);
      await updater.poll();
      const ci = file === "package-lock.json" ? [`ci ${STAGING}`] : [];
      expect(world.events).toEqual([
        "fetch",
        "ff . c2",
        `worktree add ${STAGING} c2`,
        ...ci,
        `build ${STAGING}@c2`,
        "drain 1",
        "exit 1",
        `ff ${RUNTIME} c2`,
        `launch 2 ${RUNTIME}/dist/main.js (// built from c2)`,
      ]);
      expect(launcher.children[0]!.drainAcknowledged).toBe(true);
      expect(launcher.live.map((c) => c.pid)).toEqual([2]);
      expect(existsSync(join(world.root, STAGING))).toBe(false);
      noForbidden(world);
    });
  }

  it("npm ci runs only when package-lock.json changed, and its node_modules move into the runtime copy", async () => {
    const { world, updater } = setup();
    await updater.start();
    world.push("c2", ["src/a.ts"]);
    world.push("c3", ["package-lock.json"]);
    world.events = [];
    await updater.poll();
    expect(world.events.filter((e) => e.startsWith("ci "))).toEqual([`ci ${STAGING}`]);
    expect(readFileSync(join(world.root, RUNTIME, "node_modules", "lock-of"), "utf8")).toBe("c3");

    world.push("c4", ["src/b.ts"]);
    world.events = [];
    await updater.poll();
    expect(world.events.filter((e) => e.startsWith("ci "))).toEqual([]);
    expect(readFileSync(join(world.root, RUNTIME, "node_modules", "lock-of"), "utf8")).toBe("c3");
  });

  it("a poll with no new commit does nothing but fetch", async () => {
    const { world, updater } = setup();
    await updater.start();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch"]);
  });
});

describe("updater: git-worktree status file", () => {
  it("reports running, building, draining, then running on the new revision; stopped on shutdown", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-status-")), "supervisor.json");
    const read = () => JSON.parse(readFileSync(file, "utf8")) as { state: string; rev: string | null; target_rev: string | null; child_pid: number | null };
    const { world, launcher, updater } = setup({ statusFile: file });
    await updater.start();
    expect(read()).toMatchObject({ state: "running", rev: "c1", target_rev: null, child_pid: 1 });

    launcher.children[0]!.drainMode = "hold";
    world.push("c2", ["src/core/worker.ts"]);
    const polling = updater.poll();
    await waitFor(() => existsSync(file) && read().state === "draining", "draining status");
    expect(read()).toMatchObject({ state: "draining", rev: "c1", target_rev: "c2", child_pid: 1 });
    launcher.children[0]!.finishDrain();
    await polling;
    expect(read()).toMatchObject({ state: "running", rev: "c2", target_rev: null, child_pid: 2 });

    await updater.shutdown();
    expect(read()).toMatchObject({ state: "stopped", child_pid: null });
  });
});

describe("updater: git-worktree docs-only change", () => {
  it("fast-forwards .factory/runtime without draining, killing or restarting the child", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    world.events = [];
    world.push("c2", ["docs/design.md", "README.md", "SET_UP.md"]);
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c2", `ff ${RUNTIME} c2`]);
    expect(updater.childPid()).toBe(1);
    expect(launcher.children).toHaveLength(1);
    expect(launcher.children[0]!.kills).toEqual([]);

    // The docs-only revision counts as built: a crash restarts it without a build.
    launcher.children[0]!.exit(1);
    await Promise.resolve();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", `launch 2 ${RUNTIME}/dist/main.js (// built from c1)`]);
  });
});

describe("updater: git-worktree failed build", () => {
  it("leaves the running child untouched, logs the step and output tail, and retries on the next change", async () => {
    const { world, launcher, log, updater } = setup();
    await updater.start();
    world.events = [];
    world.push("c2", ["src/core/worker.ts"]);
    world.failBuild.add("c2");
    await updater.poll();
    expect(world.events).toEqual(["fetch", "ff . c2", `worktree add ${STAGING} c2`, `build ${STAGING}@c2`]);
    expect(updater.childPid()).toBe(1);
    expect(launcher.children[0]!.kills).toEqual([]);
    const line = log.lines.find((l) => l.level === "error" && /build failed/.test(l.msg));
    expect(line?.fields).toMatchObject({ rev: "c2", step: "npm run build", exit_code: 2 });
    expect(String(line?.fields?.output_tail)).toContain("error TS2322: boom at c2");

    // Same commit: not built again.
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch"]);

    // The next change builds and restarts.
    world.push("c3", ["src/core/worker.ts"]);
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual([
      "fetch",
      "ff . c3",
      `worktree add ${STAGING} c3`,
      `build ${STAGING}@c3`,
      "drain 1",
      "exit 1",
      `ff ${RUNTIME} c3`,
      `launch 2 ${RUNTIME}/dist/main.js (// built from c3)`,
    ]);
  });

  it("after a crash, the restart runs the last tree that built, never the failed one", async () => {
    const { world, launcher, updater } = setup();
    await updater.start();
    world.push("c2", ["src/core/worker.ts"]);
    world.failBuild.add("c2");
    await updater.poll();
    launcher.children[0]!.exit(1);
    await Promise.resolve();
    world.events = [];
    await updater.poll();
    expect(world.events).toEqual(["fetch", `launch 2 ${RUNTIME}/dist/main.js (// built from c1)`]);
    expect(world.heads.get(RUNTIME)).toBe("c1");
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
    expect(world.events).toEqual(["fetch", "ff . c2", `ff ${RUNTIME} c2`, `build ${RUNTIME}@c2`, `launch 1 ${RUNTIME}/dist/main.js (// built from c2)`]);
  });

  it("a crash mid-update (runtime moved, not built) rebuilds before starting, and starts nothing if that fails", async () => {
    const a = setup();
    await a.updater.start();
    await a.updater.shutdown();
    // Simulate a supervisor that died after the fast-forward and before the swap.
    a.world.push("c2", ["src/core/worker.ts"]);
    a.world.heads.set(RUNTIME, "c2");
    a.world.failBuild.add("c2");
    const launcher = new FakeLauncher(a.world);
    const again = new GitWorktreeUpdater({ ...(a.updater as unknown as { o: GitWorktreeOptions }).o, launcher });
    a.world.events = [];
    await again.start();
    expect(a.world.events).toEqual(["fetch", "ff . c2", `build ${RUNTIME}@c2`]);
    expect(launcher.children).toEqual([]);
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
