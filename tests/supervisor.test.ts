import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { DRAIN_MARGIN_MS, GitWorktreeUpdater } from "../src/impl/updater/git-worktree.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import type { ChildHandle, ChildLauncher, ChildSpec, CommandRunner } from "../src/interfaces/updater.js";
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
  ignoreSigterm = false;

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
          mkdirSync(rest[rest.length - 2]!, { recursive: true });
          writeFileSync(join(rest[rest.length - 2]!, ".git"), "");
          this.heads.set(relative(this.root, rest[rest.length - 2]!), last);
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
      this.children.push(c);
      this.events.push(`launch ${c.pid}`);
      return c;
    },
  };
}

class FakeChild implements ChildHandle {
  drainAcknowledged = false;
  alive = true;
  readonly exited: Promise<number | null>;
  private done!: (code: number | null) => void;
  constructor(
    readonly pid: number,
    readonly spec: ChildSpec,
    private readonly f: Fake,
  ) {
    this.exited = new Promise((r) => (this.done = r));
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
    if (signal === "SIGKILL" || !this.f.ignoreSigterm) this.exit(null);
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
  });
  const signals = new EventEmitter();
  const running = supervise({ updater, clock, pollMs: POLL, log, signals, inPlace: async () => {} });
  return { f, clock, log, updater, signals, running };
}

/** Moves the fake clock one poll interval and waits for the poll to settle on `cond`. */
async function nextPoll(clock: FakeClock, cond: () => boolean, what: string) {
  clock.advance(POLL);
  await waitFor(cond, what);
}

describe("supervisor: drain", () => {
  it("sends the drain request and waits for the child's acknowledgement before moving the runtime copy", async () => {
    const { f, clock, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    // The child is still finishing its run: nothing has moved.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1"]);
    expect(f.heads.get(".factory/runtime")).toBe("c1");

    f.children[0]!.finishRun();
    await waitFor(() => f.children.length === 2, "restart");
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1", "ack 1", "exit 1", "ff .factory/runtime", "launch 2"]);
    expect(f.children[0]!.drainAcknowledged).toBe(true);

    signals.emit("SIGTERM");
    expect(await running).toBe(0);
  });

  it("hard-stops a child that has not exited within run_timeout_ms plus the margin, and logs it", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "ignore";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    await new Promise((r) => setImmediate(r));

    clock.advance(RUN_TIMEOUT + DRAIN_MARGIN_MS - 1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(f.events).not.toContain("kill SIGKILL 1");

    clock.advance(1);
    await waitFor(() => f.children.length === 2, "restart after hard stop");
    expect(f.events.slice(f.events.indexOf("drain 1"))).toEqual(["drain 1", "kill SIGKILL 1", "exit 1", "ff .factory/runtime", "launch 2"]);
    const line = log.lines.find((l) => /hard stop/.test(l.msg));
    expect(line?.level).toBe("error");
    expect(line?.fields).toMatchObject({ pid: 1, timeout_ms: RUN_TIMEOUT + DRAIN_MARGIN_MS });

    signals.emit("SIGINT");
    expect(await running).toBe(0);
  });
});

describe("supervisor: build failure", () => {
  it("keeps the old child running: no drain, no kill, no restart", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.commits.push("c2");
    f.failBuild.add("c2");
    await nextPoll(clock, () => log.lines.some((l) => /build failed/.test(l.msg)), "build failure");
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
      expect(f.children.filter((c) => c.alive)).toEqual([]);
    });
  }

  it("a child that ignores SIGTERM is killed after the drain timeout", async () => {
    const { f, clock, log, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.ignoreSigterm = true;
    signals.emit("SIGTERM");
    await waitFor(() => f.events.includes("kill SIGTERM 1"), "SIGTERM");
    clock.advance(RUN_TIMEOUT + DRAIN_MARGIN_MS);
    expect(await running).toBe(0);
    expect(f.events.slice(-3)).toEqual(["kill SIGTERM 1", "kill SIGKILL 1", "exit 1"]);
    expect(log.lines.some((l) => /hard stop/.test(l.msg))).toBe(true);
    expect(f.children.filter((c) => c.alive)).toEqual([]);
  });

  it("a signal during a drain stops the child and starts no new one", async () => {
    const { f, clock, signals, running } = setup();
    await waitFor(() => f.children.length === 1, "first child");
    f.drainMode = "hold";
    f.commits.push("c2");
    await nextPoll(clock, () => f.events.includes("drain 1"), "drain request");
    signals.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(f.children).toHaveLength(1);
    expect(f.children[0]!.alive).toBe(false);
  });
});
