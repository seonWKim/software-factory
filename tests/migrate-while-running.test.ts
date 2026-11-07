import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import {
  type MigrateWhileRunningDeps,
  liveSupervisorPid,
  migrateWhileRunning,
  parseMigrateFlags,
  runMigrateApply,
} from "../src/impl/store/mysql/migrate-command.js";
import { takeSupervisorRequest } from "../src/impl/updater/git-worktree.js";
import type { SupervisorRequest, SupervisorStatus } from "../src/interfaces/updater.js";

// `npm run migrate` while the factory runs (design §8 Self-update): drain, apply, start; cancel on failure.
// The supervisor here is a script over supervisor.json and the request file; tests/updater.test.ts drives the
// real git-worktree updater through the same files.

const SUPERVISOR = 900;

function files() {
  const dir = mkdtempSync(join(tmpdir(), "sf-mwr-"));
  return { statusFile: join(dir, "supervisor.json"), requestFile: join(dir, "supervisor-request.json") };
}

function status(over: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    state: "migration_pending",
    rev: "aaaaaaa1111",
    target_rev: "bbbbbbb2222",
    child_pid: 11,
    draining_pids: [],
    since: "2026-11-07T00:00:00.000Z",
    error: null,
    supervisor_pid: SUPERVISOR,
    pending_steps: ["0018-a.sql"],
    target_dir: "/state/versions/bbbbbbb2222",
    migration_phase: "waiting",
    ...over,
  };
}

const write = (file: string, s: SupervisorStatus) => writeFileSync(file, JSON.stringify(s));

/** A fake supervisor: on each tick it reads (and removes) a request and moves supervisor.json on. */
class ScriptedSupervisor {
  alive = new Set<number>([SUPERVISOR, 11]);
  requests: SupervisorRequest[] = [];
  /** Ticks a draining child takes to exit after the drain request. */
  drainTicks = 1;
  private draining = -1;
  events: string[] = [];

  constructor(
    private readonly f: { statusFile: string; requestFile: string },
    private s: SupervisorStatus = status(),
  ) {
    write(f.statusFile, s);
  }

  get status(): SupervisorStatus {
    return this.s;
  }

  async tick(): Promise<void> {
    const r = await takeSupervisorRequest(this.f.requestFile);
    if (r) {
      this.requests.push(r);
      this.events.push(`request ${r.action}`);
      if (r.action === "drain") {
        this.s = { ...this.s, migration_phase: "draining", child_pid: null, draining_pids: [11] };
        this.draining = this.drainTicks;
      }
      if (r.action === "start") {
        this.alive.add(12);
        this.s = { ...this.s, state: "running", rev: this.s.target_rev, target_rev: null, child_pid: 12, migration_phase: null };
        this.events.push("start target");
      }
      if (r.action === "cancel") {
        this.alive.add(13);
        this.s = { ...this.s, migration_phase: "waiting", child_pid: 13 };
        this.events.push("restart old");
      }
    } else if (this.draining > 0 && --this.draining === 0) {
      this.alive.delete(11);
      this.events.push("old child exited");
      this.s = { ...this.s, migration_phase: "drained", draining_pids: [] };
    }
    write(this.f.statusFile, this.s);
  }
}

function deps(f: { statusFile: string; requestFile: string }, sup: ScriptedSupervisor, clock: FakeClock, over: Partial<MigrateWhileRunningDeps> = {}) {
  const lines: string[] = [];
  const applied: (string | null)[] = [];
  const d: MigrateWhileRunningDeps = {
    ...f,
    clock,
    pollMs: 1000,
    drainTimeoutMs: 10_000,
    pidAlive: (pid) => sup.alive.has(pid),
    print: (l) => lines.push(l),
    pid: 4242,
    apply: async (dir) => {
      sup.events.push(`apply (children alive: ${[11, 12, 13].filter((p) => sup.alive.has(p)).join(",") || "none"})`);
      applied.push(dir);
      return 0;
    },
    ...over,
  };
  return { d, lines, applied };
}

/** Runs the migrate command against the scripted supervisor: one supervisor tick per poll interval. */
async function drive(sup: ScriptedSupervisor, clock: FakeClock, run: Promise<number>, maxTicks = 50): Promise<number> {
  let done: number | null = null;
  void run.then((c) => (done = c));
  for (let i = 0; i < maxTicks && done === null; i++) {
    await new Promise((r) => setImmediate(r));
    await sup.tick();
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
  }
  await sup.tick();
  return run;
}

describe("npm run migrate with a live supervisor", () => {
  it("writes a drain request, waits until no child is live (printing progress), applies, then writes a start request", async () => {
    const f = files();
    const sup = new ScriptedSupervisor(f);
    sup.drainTicks = 3;
    const clock = new FakeClock();
    const { d, lines, applied } = deps(f, sup, clock);
    expect(await drive(sup, clock, migrateWhileRunning(d))).toBe(0);
    expect(sup.requests.map((r) => r.action)).toEqual(["drain", "start"]);
    expect(sup.requests[0]).toMatchObject({ target_rev: "bbbbbbb2222", pid: 4242 });
    // Applied only after the old child exited; then the target starts, the old one is not restarted.
    expect(sup.events).toEqual(["request drain", "old child exited", "apply (children alive: none)", "request start", "start target"]);
    expect(applied).toEqual(["/state/versions/bbbbbbb2222"]);
    expect(lines.some((l) => /waiting for the factory to drain: 1 child live \(11\)/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/asked the factory to start bbbbbbb/);
    expect(sup.status).toMatchObject({ state: "running", rev: "bbbbbbb2222", child_pid: 12 });
  });

  it("gives up at the drain timeout and writes a cancel request; nothing is applied", async () => {
    const f = files();
    const sup = new ScriptedSupervisor(f);
    sup.drainTicks = 1000; // the in-flight run never finishes
    const clock = new FakeClock();
    const { d, lines, applied } = deps(f, sup, clock, { drainTimeoutMs: 5000 });
    expect(await drive(sup, clock, migrateWhileRunning(d))).toBe(1);
    expect(applied).toEqual([]);
    expect(sup.requests.map((r) => r.action)).toEqual(["drain", "cancel"]);
    expect(lines.filter((l) => /gave up after/.test(l)), lines.join("\n")).toEqual([expect.stringMatching(/gave up after [56] s/)]);
    expect(sup.events).toContain("restart old");
  });

  it("a failed apply writes a cancel request, and the supervisor restarts the old revision", async () => {
    const f = files();
    const sup = new ScriptedSupervisor(f);
    const clock = new FakeClock();
    const { d, lines } = deps(f, sup, clock, {
      apply: async () => {
        sup.events.push("apply fails");
        return 1;
      },
    });
    expect(await drive(sup, clock, migrateWhileRunning(d))).toBe(1);
    expect(sup.events).toEqual(["request drain", "old child exited", "apply fails", "request cancel", "restart old"]);
    expect(lines.at(-1)).toMatch(/applying failed: asked the factory to restart aaaaaaa/);
    expect(sup.status).toMatchObject({ state: "migration_pending", migration_phase: "waiting", child_pid: 13 });
  });

  it("a target that changes while waiting cancels: the steps checked are the steps applied", async () => {
    const f = files();
    const sup = new ScriptedSupervisor(f);
    sup.drainTicks = 1000;
    const clock = new FakeClock();
    const { d, applied } = deps(f, sup, clock);
    let ticks = 0;
    const tick = sup.tick.bind(sup);
    // After the drain is picked up, a newer revision replaces the target.
    sup.tick = async () => {
      await tick();
      if (++ticks === 2) write(f.statusFile, { ...sup.status, target_rev: "ccccccc3333" });
    };
    expect(await drive(sup, clock, migrateWhileRunning(d))).toBe(1);
    expect(applied).toEqual([]);
    expect(sup.requests.map((r) => r.action)).toEqual(["drain", "cancel"]);
  });
});

describe("npm run migrate: which path", () => {
  const paths = async (o: { drain: boolean; s: SupervisorStatus | null; alive: number[] }) => {
    const f = files();
    if (o.s) write(f.statusFile, o.s);
    const before = o.s ? readFileSync(f.statusFile, "utf8") : null;
    const took: string[] = [];
    const code = await runMigrateApply({
      drain: o.drain,
      statusFile: f.statusFile,
      pidAlive: (p) => o.alive.includes(p),
      direct: async () => (took.push("direct"), 0),
      whileRunning: async () => (took.push("while running"), 0),
    });
    expect(code).toBe(0);
    expect(existsSync(f.requestFile), "no request is written").toBe(false);
    if (before !== null) expect(readFileSync(f.statusFile, "utf8")).toBe(before);
    return took;
  };

  it("--no-drain applies the steps directly without touching the supervisor", async () => {
    expect(parseMigrateFlags(["--no-drain"])).toEqual({ mode: "apply", json: false, drain: false });
    expect(parseMigrateFlags([], { npm_config_drain: "false" })).toMatchObject({ drain: false });
    expect(await paths({ drain: false, s: status({ state: "running" }), alive: [SUPERVISOR, 11] })).toEqual(["direct"]);
  });

  it("with no live supervisor pid, it applies directly as --no-drain does", async () => {
    expect(await paths({ drain: true, s: null, alive: [] })).toEqual(["direct"]);
    expect(await paths({ drain: true, s: status({ state: "running" }), alive: [11] })).toEqual(["direct"]);
    expect(await paths({ drain: true, s: status({ state: "stopped" }), alive: [SUPERVISOR] })).toEqual(["direct"]);
    expect(await paths({ drain: true, s: status({ supervisor_pid: null }), alive: [SUPERVISOR] })).toEqual(["direct"]);
  });

  it("with a live supervisor it goes through the drain protocol", async () => {
    expect(parseMigrateFlags([])).toEqual({ mode: "apply", json: false, drain: true });
    expect(await paths({ drain: true, s: status({ state: "running" }), alive: [SUPERVISOR] })).toEqual(["while running"]);
    expect(liveSupervisorPid(status(), (p) => p === SUPERVISOR)).toBe(SUPERVISOR);
  });

  it("--json goes only with --status; unknown flags still fail", () => {
    expect(parseMigrateFlags(["--status", "--json"])).toEqual({ mode: "status", json: true, drain: true });
    expect(parseMigrateFlags(["--json"])).toEqual({ error: expect.stringContaining("--status") });
    expect(parseMigrateFlags(["--down"])).toEqual({ error: expect.stringContaining("--down") });
  });
});
