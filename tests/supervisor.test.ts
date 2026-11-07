import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { DRAIN_MARGIN_MS, GitWorktreeUpdater } from "../src/impl/updater/git-worktree.js";
import { NoneUpdater } from "../src/impl/updater/none.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { type ChildHandle, type ChildLauncher, type ChildSpec, type CommandRunner, WORKER_INDEX_BASE_ENV } from "../src/interfaces/updater.js";
import { supervise } from "../src/supervisor.js";
import { recordingLog, waitFor } from "./helpers/fakes.js";

// The supervisor end to end, with fake git/npm (a linear history; every change touches src/) and a fake
// launcher whose children answer a drain the way the test says.

const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });

class Fake {
  readonly root = mkdtempSync(join(tmpdir(), "sf-supervisor-"));
  events: string[] = [];
  commits = ["c1"];
  heads = new Map<string, string>([[".", "c1"]]);
  failBuild = new Set<string>();
  children: FakeChild[] = [];
  drainMode: "ack" | "hold" | "ignore" = "ack";
  /** `workers` in each new folder's factory.config.json; 0: none (block size 1). */
  workers = 0;
  /** `max_workers` in that file; 0: none (block size `workers`). */
  maxWorkers = 0;

  get origin(): string {
    return this.commits[this.commits.length - 1]!;
  }

  run: CommandRunner = async (cmd, opts) => {
    const dir = relative(this.root, opts.cwd) || ".";
    const [tool, sub, ...rest] = cmd;
    const last = rest[rest.length - 1]!;
    if (tool === "npm") {
      if (sub === "ci") return mkdirSync(join(opts.cwd, "node_modules"), { recursive: true }), ok();
      const rev = this.heads.get(dir)!;
      this.events.push(`build ${rev}`);
      if (this.failBuild.has(rev)) return { exit_code: 2, signal: null, stdout: "error TS1005: nope", stderr: "", timed_out: false };
      mkdirSync(join(opts.cwd, "dist"), { recursive: true });
      writeFileSync(join(opts.cwd, "dist", "main.js"), rev);
      return ok();
    }
    switch (sub) {
      case "fetch":
      case "status":
        return ok();
      case "rev-parse":
        if (rest[0] === "HEAD") return ok(this.heads.get(dir));
        if (rest[0] === "--abbrev-ref") return ok("main");
        return ok(this.origin);
      case "worktree":
        if (rest[0] === "add") {
          const path = rest[rest.length - 2]!;
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, ".git"), "");
          if (this.workers) {
            const file = { workers: this.workers, ...(this.maxWorkers ? { max_workers: this.maxWorkers } : {}) };
            writeFileSync(join(path, "factory.config.json"), JSON.stringify(file));
          }
          this.heads.set(relative(this.root, path), last);
        } else if (rest[0] === "remove") rmSync(last, { recursive: true, force: true });
        return ok();
      case "diff":
        return ok("src/core/worker.ts");
      case "merge-base":
        return ok();
      case "merge":
        this.events.push(`ff ${dir}`);
        this.heads.set(dir, last === "origin/main" ? this.origin : last);
        return ok();
    }
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };

  launcher: ChildLauncher = {
    launch: (spec: ChildSpec): ChildHandle => {
      const c = new FakeChild(this.children.length + 1, spec, this);
      // The criterion: the older children are still alive when the new one launches.
      this.events.push(`launch ${c.pid}${this.live.length ? ` (alive: ${this.live.map((x) => x.pid).join(",")})` : ""}`);
      this.children.push(c);
      return c;
    },
  };

  get live(): FakeChild[] {
    return this.children.filter((c) => c.alive);
  }
}

class FakeChild implements ChildHandle {
  drainAcknowledged = false;
  lastError: string | null = null;
  alive = true;
  ignoreSigterm = false;
  readonly exited: Promise<number | null>;
  private done!: (code: number | null) => void;
  constructor(
    readonly pid: number,
    readonly spec: ChildSpec,
    private readonly f: Fake,
  ) {
    this.exited = new Promise((r) => (this.done = r));
  }
  get base(): number {
    return Number(this.spec.env[WORKER_INDEX_BASE_ENV]);
  }
  requestDrain(): void {
    this.f.events.push(`drain ${this.pid}`);
    if (this.f.drainMode === "ack") queueMicrotask(() => this.finishRun());
  }
  /** The in-flight run completed: the child acknowledges the drain, then exits. */
  finishRun(): void {
    this.f.events.push(`ack ${this.pid}`);
    this.drainAcknowledged = true;
    this.exit(0);
  }
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.f.events.push(`kill ${signal} ${this.pid}`);
    if (signal === "SIGKILL" || !this.ignoreSigterm) this.exit(null);
  }
  exit(code: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.f.events.push(`exit ${this.pid}`);
    this.done(code);
  }
}

const RUN_TIMEOUT = 10_000;
const POLL = 1000;

function setup() {
  const f = new Fake();
  const clock = new FakeClock();
  const log = recordingLog();
  const updater = new GitWorktreeUpdater({
    repoPath: f.root,
    runtimeDir: join(f.root, ".factory", "runtime"),
    stagingDir: join(f.root, ".factory", "runtime-next"),
    baseBranch: "main",
    run: f.run,
    launcher: f.launcher,
    clock,
    log,
    env: { PATH: "/usr/bin" },
    runTimeoutMs: RUN_TIMEOUT,
    pidAlive: (pid) => f.live.some((c) => c.pid === pid),
  });
  const signals = new EventEmitter();
  const running = supervise({ updater, clock, pollMs: POLL, log, signals, inPlace: async () => {} });
  return { f, clock, log, updater, signals, running };
}

/** Waits until the supervisor sleeps between polls (its last step is done). */
async function idle(clock: FakeClock) {
  const sleepers = () => (clock as unknown as { sleepers: { wakeAt: number }[] }).sleepers;
  await waitFor(() => sleepers().some((s) => s.wakeAt === clock.now().getTime() + POLL), "supervisor idle");
}

/** Once the supervisor is idle, moves the fake clock one poll interval and waits for the poll to settle on `cond`. */
async function nextPoll(clock: FakeClock, cond: () => boolean, what: string) {
  await idle(clock);
  clock.advance(POLL);
  await waitFor(cond, what);
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Resolves true if `p` settled within a few event-loop turns. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await settle();
  return done;
}

describe("supervisor: start-then-drain", () => {
  it("starts the new child while the old one is alive, then asks the old one to drain", async () => {
    const { f, clock, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    expect(f.events.slice(f.events.indexOf("build c2"))).toEqual(["build c2", "launch 2 (alive: 1)", "drain 1"]);
    expect(f.children[0]!.alive).toBe(true);
    expect(f.children[0]!.spec.env.SOFTWARE_FACTORY_CODE_ROOT).toBe(join(f.root, ".factory", "versions", "c1"));
    expect(f.children[1]!.spec.env.SOFTWARE_FACTORY_CODE_ROOT).toBe(join(f.root, ".factory", "versions", "c2"));

    // Polls go on while the old child finishes its run; it is never signalled.
    await nextPoll(clock, () => true, "next poll");
    await settle();
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1"]);

    f.children[0]!.finishRun();
    await settle();
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1", "ack 1", "exit 1"]);
    expect(f.events.some((e) => e.startsWith("kill"))).toBe(false);
    expect(f.children[1]!.alive).toBe(true);

    signals.emit("SIGTERM");
    expect(await running).toBe(0);
  });

  it("the old child exits after its last run completes, not before, and that is not logged as a crash", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    clock.advance(RUN_TIMEOUT); // the run takes a while, within the timeout
    await settle();
    expect(f.children[0]!.alive).toBe(true);
    f.children[0]!.finishRun();
    await settle();
    expect(f.events.indexOf("exit 1")).toBeGreaterThan(f.events.indexOf("ack 1"));
    // Past the hard-stop deadline: nothing more happens to the child that already exited.
    clock.advance(DRAIN_MARGIN_MS);
    await settle();
    expect(f.events.filter((e) => e.startsWith("kill"))).toEqual([]);
    expect(log.lines.some((l) => /unexpectedly|crash/.test(l.msg))).toBe(false);
    expect(log.lines.some((l) => /hard stop/.test(l.msg))).toBe(false);

    signals.emit("SIGTERM");
    await running;
  });

  it("hard-stops an old child that has not exited within run_timeout_ms plus the margin, and logs it", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "ignore";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    await settle();

    clock.advance(RUN_TIMEOUT + DRAIN_MARGIN_MS - 1);
    await settle();
    expect(f.events).not.toContain("kill SIGKILL 1");

    clock.advance(1);
    await waitFor(() => f.events.includes("exit 1"), "hard stop");
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1", "kill SIGKILL 1", "exit 1"]);
    const line = log.lines.find((l) => /hard stop/.test(l.msg));
    expect(line?.level).toBe("error");
    expect(line?.fields).toMatchObject({ pid: 1, timeout_ms: RUN_TIMEOUT + DRAIN_MARGIN_MS });
    expect(f.children[1]!.alive).toBe(true);

    signals.emit("SIGINT");
    expect(await running).toBe(0);
  });
});

describe("supervisor: worker index ranges", () => {
  it("each child gets a block of `workers` indexes no live child uses: the lowest free one", async () => {
    const { f, clock, signals, running } = setup();
    f.workers = 3;
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.children.length === 2, "second child");
    f.commits.push("c3");
    await nextPoll(clock, () => f.children.length === 3, "third child");
    expect(f.children.map((c) => c.base)).toEqual([0, 3, 6]);
    const ranges = f.live.map((c) => [c.base, c.base + 3] as const);
    for (const [i, a] of ranges.entries()) for (const b of ranges.slice(i + 1)) expect(a[1] <= b[0] || b[1] <= a[0]).toBe(true);

    f.children[0]!.finishRun(); // block 0–2 is free again
    await settle();
    f.commits.push("c4");
    await nextPoll(clock, () => f.children.length === 4, "fourth child");
    expect(f.children[3]!.base).toBe(0);

    signals.emit("SIGTERM");
    await running;
  });
});

describe("supervisor: worker index ranges with max_workers", () => {
  it("a child's block is max_workers wide, so a later rise in the live workers setting shares no index", async () => {
    const { f, clock, signals, running } = setup();
    f.workers = 1;
    f.maxWorkers = 4;
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.children.length === 2, "second child");
    expect(f.children.map((c) => c.base)).toEqual([0, 4]);
    signals.emit("SIGTERM");
    await running;
  });
});

describe("supervisor: build failure", () => {
  it("keeps the old child running: no new child, no drain, no kill", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.commits.push("c2");
    f.failBuild.add("c2");
    await nextPoll(clock, () => log.lines.some((l) => /build failed/.test(l.msg)), "build failure");
    await settle();
    expect(f.events).toEqual(["build c1", "launch 1", "ff .", "build c2"]);
    expect(f.children[0]!.alive).toBe(true);
    signals.emit("SIGTERM");
    await running;
  });
});

describe("supervisor: signals", () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`${sig} stops the child and the supervisor exits, leaving no orphan`, async () => {
      const { f, signals, running } = setup();
      await waitFor(() => f.children.length === 1, "first child");
      signals.emit(sig);
      expect(await running).toBe(0);
      expect(f.events.slice(-2)).toEqual(["kill SIGTERM 1", "exit 1"]);
      expect(f.live).toEqual([]);
    });

    it(`${sig} with two live children (old draining, new claiming) stops both and returns only after both exited`, async () => {
      const { f, clock, updater, signals, running } = setup();
      await waitFor(() => f.children.length === 1, "first child");
      f.drainMode = "hold";
      f.commits.push("c2");
      await nextPoll(clock, () => f.events.includes("drain 1"), "second child, first draining");
      expect(updater.childPids()).toEqual([1, 2]);
      f.children[0]!.ignoreSigterm = true; // the old child is slow to stop

      signals.emit(sig);
      await waitFor(() => f.events.includes("kill SIGTERM 1") && f.events.includes("kill SIGTERM 2"), "SIGTERM to both");
      expect(f.children[1]!.alive).toBe(false);
      expect(await settled(running)).toBe(false); // child 1 is still alive
      clock.advance(RUN_TIMEOUT + DRAIN_MARGIN_MS);
      expect(await running).toBe(0);
      expect(f.events.slice(-2)).toEqual(["kill SIGKILL 1", "exit 1"]);
      expect(f.live).toEqual([]);
      expect(f.children).toHaveLength(2);
    });
  }

  it("a child that ignores SIGTERM is killed after the drain timeout", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.children[0]!.ignoreSigterm = true;
    signals.emit("SIGTERM");
    await waitFor(() => f.events.includes("kill SIGTERM 1"), "SIGTERM");
    clock.advance(RUN_TIMEOUT + DRAIN_MARGIN_MS);
    expect(await running).toBe(0);
    expect(f.events.slice(-3)).toEqual(["kill SIGTERM 1", "kill SIGKILL 1", "exit 1"]);
    expect(log.lines.some((l) => /hard stop/.test(l.msg))).toBe(true);
    expect(f.live).toEqual([]);
  });
});

describe("supervisor: in place (updater none)", () => {
  function inPlaceSetup(head: ExecResult | Error = ok("c9\n")) {
    const dir = mkdtempSync(join(tmpdir(), "sf-inplace-"));
    const statusFile = join(dir, "supervisor.json");
    const calls: string[] = [];
    const run: CommandRunner = async (cmd, opts) => {
      calls.push(`${opts.cwd}: ${cmd.join(" ")}`);
      if (head instanceof Error) throw head;
      return head;
    };
    const updater = new NoneUpdater({ repoPath: dir, run, env: { PATH: "/usr/bin" }, clock: new FakeClock(), log: recordingLog(), statusFile });
    const read = () => JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
    return { dir, statusFile, calls, updater, read, signals: new EventEmitter() };
  }

  it("writes running (child_pid: this process, rev: HEAD, no supervisor_pid) before the in-place run starts", async () => {
    const s = inPlaceSetup();
    let seen: Record<string, unknown> | null = null;
    const code = await supervise({
      updater: s.updater,
      clock: new FakeClock(),
      pollMs: POLL,
      log: recordingLog(),
      signals: s.signals,
      inPlace: async () => void (seen = s.read()),
    });
    expect(code).toBe(0);
    expect(seen).toMatchObject({ state: "running", child_pid: process.pid, rev: "c9", target_rev: null });
    expect(seen).not.toHaveProperty("supervisor_pid");
    expect(s.calls).toEqual([`${s.dir}: git rev-parse HEAD`]);
    expect(existsSync(`${s.statusFile}.tmp`)).toBe(false);
  });

  it("rev is null when git rev-parse fails", async () => {
    for (const head of [{ ...ok(), exit_code: 128 }, new Error("spawn git ENOENT")]) {
      const s = inPlaceSetup(head);
      let seen: Record<string, unknown> | null = null;
      await supervise({ updater: s.updater, clock: new FakeClock(), pollMs: POLL, log: recordingLog(), signals: s.signals, inPlace: async () => void (seen = s.read()) });
      expect(seen).toMatchObject({ state: "running", rev: null });
    }
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    it(`${sig}: once the in-place run returns, the file says stopped with child_pid null`, async () => {
      const s = inPlaceSetup();
      let started = false;
      const running = supervise({
        updater: s.updater,
        clock: new FakeClock(),
        pollMs: POLL,
        log: recordingLog(),
        signals: s.signals,
        inPlace: (signal) =>
          new Promise<void>((resolve) => {
            started = true;
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      });
      await waitFor(() => started, "in-place run started");
      expect(s.read()).toMatchObject({ state: "running" });
      s.signals.emit(sig);
      expect(await running).toBe(0);
      expect(s.read()).toMatchObject({ state: "stopped", child_pid: null, rev: "c9" });
      expect(s.read()).not.toHaveProperty("supervisor_pid");
    });
  }

  it("an in-place run that throws still ends stopped, and the error reaches the caller", async () => {
    const s = inPlaceSetup();
    const running = supervise({
      updater: s.updater,
      clock: new FakeClock(),
      pollMs: POLL,
      log: recordingLog(),
      signals: s.signals,
      inPlace: async () => {
        throw new Error("store unreachable");
      },
    });
    await expect(running).rejects.toThrow("store unreachable");
    expect(s.read()).toMatchObject({ state: "stopped", child_pid: null });
  });
});
