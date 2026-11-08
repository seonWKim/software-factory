import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_INDEX_BASE_ENV, build, loadConfig, maxWorkers, workerCount, workerIndexBase } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/log.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { type RunKind, usageTokens } from "../src/core/types.js";
import { CountedKeepAwake, WorkerPool } from "../src/worker/index.js";
import { testWorkerShare } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { KeepAwake } from "../src/interfaces/keep-awake.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { runDevChild } from "../src/supervisor.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, recordingLog, silent, triageSpec, waitFor, fakeRepoLookup } from "./helpers/fakes.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Writes hold/release into a shared list, so the order against runs is visible. */
class RecordingAwake implements KeepAwake {
  constructor(private readonly events: string[]) {}
  async hold(): Promise<void> {
    this.events.push("hold");
  }
  async release(): Promise<void> {
    this.events.push("release");
  }
}

/** A gate per triage run, opened by the test; each run records "start:<n>" and "end:<n>". */
function gatedRunner(events: string[]) {
  const gates: (() => void)[] = [];
  let started = 0;
  const runner = new FakeRunner({
    triage: async () => {
      const n = started++;
      events.push(`start:${n}`);
      await new Promise<void>((r) => (gates[n] = r));
      events.push(`end:${n}`);
      return { output: triageSpec };
    },
  });
  return { runner, gates, started: () => started };
}

async function setup(opts: { workers: number; queued: number; awake?: (events: string[]) => KeepAwake; log?: Logger; indexBase?: number }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  for (let i = 1; i <= opts.queued; i++) {
    await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
  }
  const events: string[] = [];
  const { runner, gates, started } = gatedRunner(events);
  const claimRun = vi.spyOn(store, "claimRun");
  const completeRun = vi.spyOn(store, "completeRun");
  const cfg: FactoryConfig = { ...config, workers: opts.workers };
  const pool = new WorkerPool({
    id_prefix: "host:42", store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: opts.log ?? silent, scanner: cleanScanner, toolEnv: {},
    awake: opts.awake ? opts.awake(events) : new NoKeepAwake(),
    ...(opts.indexBase !== undefined ? { index_base: opts.indexBase } : {}),
  });
  const running = async () => store.listRunsByStatus(["running"], 100);
  return { store, pool, runner, gates, started, events, running, claimRun, completeRun, clock };
}

describe("workers config", () => {
  it("absent means 1; an integer of 1 or more is kept", () => {
    expect(workerCount(undefined)).toBe(1);
    expect(workerCount(1)).toBe(1);
    expect(workerCount(3)).toBe(3);
  });

  it("any other value stops startup with a clear error", () => {
    for (const bad of [0, -1, 1.5, "2", null, Number.NaN, Infinity, [2]]) {
      expect(() => workerCount(bad)).toThrow("workers must be an integer of 1 or more");
    }
  });

  /** A config dir like the checked-in one, on SQLite, without its max_workers (so slots = workers), with `over` merged in. */
  function root(over: Record<string, unknown>): string {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), "sf-pool-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const plugins = { ...(real.plugins as object), awake: "none" };
    const file = { ...real, max_workers: undefined, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt", ...over };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify(file));
    writeFileSync(join(dir, "secrets.env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
    return dir;
  }

  it("max_workers: absent means workers; an integer of at least workers is kept; anything else stops startup", () => {
    expect(maxWorkers(3, undefined)).toBe(3);
    expect(maxWorkers(3, 3)).toBe(3);
    expect(maxWorkers(1, 8)).toBe(8);
    for (const bad of [2, 0, 1.5, "8", null, [8]]) {
      expect(() => maxWorkers(3, bad)).toThrow("max_workers must be an integer of at least workers (3)");
    }
  });

  it("loadConfig carries max_workers (absent: workers); build() makes that many slots, `workers` of them claiming", async () => {
    expect((await loadConfig(root({ workers: 2, max_workers: undefined }))).config.max_workers).toBe(2);
    await expect(loadConfig(root({ workers: 3, max_workers: 2 }))).rejects.toThrow("max_workers must be an integer of at least workers (3)");
    const built = await build(await loadConfig(root({ workers: 1, max_workers: 4 })), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect(built.worker.workers).toHaveLength(4);
      expect(built.worker.size()).toBe(1);
    } finally {
      await built.close();
    }
  });

  it("loadConfig carries workers into FactoryConfig (absent: 1) and refuses a bad value", async () => {
    // undefined drops the key, whatever the real config sets.
    expect((await loadConfig(root({ workers: undefined }))).config.workers).toBe(1);
    expect((await loadConfig(root({ workers: 3 }))).config.workers).toBe(3);
    await expect(loadConfig(root({ workers: 0 }))).rejects.toThrow("workers must be an integer of 1 or more");
  });

  it("build() numbers its workers from SF_WORKER_INDEX_BASE (set by the supervisor; unset: 0)", async () => {
    vi.stubEnv(WORKER_INDEX_BASE_ENV, "6");
    const built = await build(await loadConfig(root({ workers: 3 })), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect(built.worker.workers.map((w) => w.id)).toEqual([6, 7, 8].map((n) => `${hostname()}:${process.pid}:${n}`));
    } finally {
      await built.close();
    }
  });

  it("SF_WORKER_INDEX_BASE: a non-negative integer is used; unset, empty or anything else is 0", () => {
    expect(workerIndexBase(undefined)).toBe(0);
    expect(workerIndexBase("")).toBe(0);
    expect(workerIndexBase("3")).toBe(3);
    expect(workerIndexBase(" 12 ")).toBe(12);
    for (const bad of ["-1", "1.5", "x", "2e3"]) expect(workerIndexBase(bad)).toBe(0);
  });

  it("build() starts `workers` workers in one pool, each with id <host>:<pid>:<n>", async () => {
    const built = await build(await loadConfig(root({ workers: 3 })), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect(built.worker).toBeInstanceOf(WorkerPool);
      const ids = built.worker.workers.map((w) => w.id);
      expect(ids).toEqual([0, 1, 2].map((n) => `${hostname()}:${process.pid}:${n}`));
    } finally {
      await built.close();
    }
  });
});

describe("worker pool", () => {
  it("workers: 3 runs three runs at once, each claimed by a different worker", async () => {
    const s = await setup({ workers: 3, queued: 4 });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 3, "three runs in flight");
    const running = await s.running();
    expect(running).toHaveLength(3);
    expect(new Set(running.map((r) => r.lease!.owner))).toEqual(new Set(["host:42:0", "host:42:1", "host:42:2"]));
    expect(s.started()).toBe(3);

    stop.abort();
    s.gates.forEach((g) => g());
    await loops;
  });

  it("workers: 1 runs one run at a time", async () => {
    const s = await setup({ workers: 1, queued: 2 });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 1, "a run in flight");
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(s.started()).toBe(1);
    expect(await s.running()).toHaveLength(1);
    stop.abort();
    s.gates[0]!();
    await loops;
  });

  it("KeepAwake is held while any run is in progress and released only after the last run finishes", async () => {
    const s = await setup({ workers: 3, queued: 3, awake: (e) => new RecordingAwake(e) });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 3, "three runs in flight");
    expect(s.events.filter((e) => e === "hold")).toHaveLength(1);
    expect(s.events[0]).toBe("hold");

    s.gates[1]!();
    await waitFor(async () => (await s.running()).length === 2, "one run done");
    s.gates[0]!();
    await waitFor(async () => (await s.running()).length === 1, "two runs done");
    expect(s.events).not.toContain("release");

    s.gates[2]!();
    await waitFor(() => s.events.includes("release"), "release");
    stop.abort();
    await loops;
    expect(s.events.filter((e) => e === "hold")).toHaveLength(1);
    expect(s.events.filter((e) => e === "release")).toHaveLength(1);
    // Released after the last run ended.
    expect(s.events.indexOf("release")).toBeGreaterThan(s.events.indexOf("end:2"));
  });

  it("drain lets every in-flight run finish, claims nothing after it, and acknowledges only after all finish", async () => {
    const s = await setup({ workers: 3, queued: 5 });
    let onDrain: () => void = () => {};
    const channel = {
      onDrain: (cb: () => void) => void (onDrain = cb),
      acknowledge: async () => void s.events.push("ack"),
    };
    const controller = { run: async (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener("abort", () => r())), tickRuns: async () => {} };
    const stop = new AbortController();
    const child = runDevChild({ controller, worker: s.pool }, channel, stop.signal);
    await waitFor(() => s.started() === 3, "three runs in flight");
    const claims = s.claimRun.mock.calls.length;

    onDrain();
    s.gates[0]!();
    await waitFor(() => s.completeRun.mock.calls.length === 1, "first run completes");
    expect(s.events).not.toContain("ack");
    s.gates[2]!();
    await waitFor(() => s.completeRun.mock.calls.length === 2, "second run completes");
    expect(s.events).not.toContain("ack");
    s.gates[1]!();

    expect(await child).toBe("drained");
    expect(s.completeRun).toHaveBeenCalledTimes(3);
    for (const r of s.completeRun.mock.results) expect(await r.value).toMatchObject({ ok: true });
    expect(s.claimRun.mock.calls.length).toBe(claims);
    expect(s.started()).toBe(3);
    expect(s.events.at(-1)).toBe("ack");
    expect(s.events.filter((e) => e === "ack")).toHaveLength(1);
    expect(await s.store.listRunsByStatus(["queued"], 10)).toHaveLength(2);
  });

  it("run start and run done log lines include the worker id", async () => {
    const log = recordingLog();
    const s = await setup({ workers: 2, queued: 1, log });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 1, "a run in flight");
    s.gates[0]!();
    await waitFor(() => log.lines.some((l) => l.msg === "run done"), "run done");
    stop.abort();
    await loops;
    const owner = (await s.store.listRunsByStatus(["succeeded"], 1))[0]!;
    const start = log.lines.find((l) => l.msg === "run start")!;
    const done = log.lines.find((l) => l.msg === "run done")!;
    expect(start.fields?.worker_id).toMatch(/^host:42:[01]$/);
    expect(done.fields?.worker_id).toBe(start.fields?.worker_id);
    expect(owner.id).toBe(start.fields?.run_id);
  });
  it("run done carries error_code, failure, tokens and duration_ms, and never the outcome's detail", async () => {
    const log = recordingLog();
    const s = await setup({ workers: 1, queued: 2, log });
    let n = 0;
    s.runner.script.triage = async () => {
      // The run takes 1500 ms on the fake clock; the first returns output that fails validation.
      s.clock.advance(1_500);
      return n++ === 0 ? { output: { not: "a spec" } } : { output: triageSpec };
    };
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => log.lines.filter((l) => l.msg === "run done").length === 2, "two runs done");
    stop.abort();
    await loops;
    const done = log.lines.filter((l) => l.msg === "run done");
    const keys = ["error_code", "failure", "tokens", "duration_ms"];
    for (const line of done) {
      const run = (await s.store.getRun(line.fields!.run_id as never))!;
      const outcome = run.outcome!;
      expect(typeof line.fields?.duration_ms).toBe("number");
      expect(line.fields?.duration_ms).toBeGreaterThanOrEqual(1_500);
      if (outcome.status === "failed") {
        expect(line.fields?.error_code).toBe(outcome.error_code);
        expect(line.fields?.error_code).toBe("invalid_output");
        expect(line.fields?.failure).toBe("task");
        expect(line.fields?.tokens).toBe(usageTokens(outcome.usage!));
        expect(line.fields?.tokens).toBe(15);
        // Only codes and numbers: the detail text is nowhere in the line.
        expect(outcome.detail.length).toBeGreaterThan(0);
        expect(JSON.stringify(line.fields)).not.toContain(outcome.detail);
      } else {
        expect(line.fields?.error_code).toBeNull();
        expect(line.fields?.failure).toBeNull();
        expect(line.fields?.tokens).toBe((outcome.data as { tokens: number }).tokens);
        expect(line.fields?.tokens).toBe(15);
      }
      for (const k of keys) expect(["string", "number", "object"]).toContain(typeof line.fields?.[k]);
    }
    expect(done.map((l) => l.fields?.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("lease lost before completion carries the same fields, with the tokens used so far", async () => {
    const log = recordingLog();
    const s = await setup({ workers: 1, queued: 1, log });
    s.completeRun.mockResolvedValueOnce({ ok: false, reason: "lease_lost" });
    s.runner.script.triage = async () => {
      s.clock.advance(700);
      return { output: { not: "a spec" } };
    };
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    const msg = "lease lost before completion; outcome dropped";
    await waitFor(() => log.lines.some((l) => l.msg === msg), "lease lost line");
    stop.abort();
    await loops;
    const line = log.lines.find((l) => l.msg === msg)!;
    expect(line.fields).toMatchObject({ error_code: "invalid_output", failure: "task", tokens: 15 });
    expect(line.fields?.duration_ms).toBeGreaterThanOrEqual(700);
    expect(line.fields?.status).toBeUndefined();
    expect(log.lines.some((l) => l.msg === "run done")).toBe(false);
  });
});

describe("worker pool: the worker slots line", () => {
  /** A pool of `max` slots whose live `workers` comes from the store's settings overrides. */
  async function livePool(max: number) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const log = recordingLog();
    const cfg: FactoryConfig = { ...config, workers: max };
    const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store, log: silent });
    const pool = new WorkerPool({
      id_prefix: "host:42", store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config: cfg, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
    });
    const slotLines = () => log.lines.filter((l) => l.msg === "worker slots").map((l) => l.fields);
    const set = (v: number) => store.setSettingOverride({ key: "workers", project: "", value: String(v), actor: "local:test" });
    /** One pool tick: the next sleep ends, then the pool's loop gets to run. */
    const tick = async () => {
      clock.advance(cfg.tick_ms);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    return { pool, store, clock, log, slotLines, set, tick, cfg };
  }

  it("start: one line with pid, the live count, from null and reason start", async () => {
    const p = await livePool(3);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    await waitFor(() => p.slotLines().length === 1, "start line");
    expect(p.slotLines()).toEqual([{ pid: 42, slots: 3, from: null, reason: "start" }]);
    stop.abort();
    await loops;
  });

  it("settings change: one line on the next tick with the new and old count, even when three slots stop", async () => {
    const p = await livePool(4);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    await waitFor(() => p.slotLines().length === 1, "start line");
    await p.set(1);
    await p.tick();
    await waitFor(() => p.slotLines().length === 2, "settings change line");
    expect(p.slotLines()[1]).toEqual({ pid: 42, slots: 1, from: 4, reason: "settings change" });
    await p.set(3);
    await p.tick();
    await waitFor(() => p.slotLines().length === 3, "second settings change line");
    expect(p.slotLines()[2]).toEqual({ pid: 42, slots: 3, from: 1, reason: "settings change" });
    expect(p.log.lines.some((l) => l.msg.includes("workers lowered"))).toBe(false);
    stop.abort();
    await loops;
  });

  it("a tick where the live count is unchanged logs no line", async () => {
    const p = await livePool(2);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    await waitFor(() => p.slotLines().length === 1, "start line");
    for (let i = 0; i < 5; i++) await p.tick();
    expect(p.slotLines()).toHaveLength(1);
    stop.abort();
    await loops;
  });

  it("drain: one line with slots 0, from the last count, reason drain", async () => {
    const p = await livePool(2);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    await waitFor(() => p.slotLines().length === 1, "start line");
    stop.abort();
    await loops;
    expect(p.slotLines()).toEqual([
      { pid: 42, slots: 2, from: null, reason: "start" },
      { pid: 42, slots: 0, from: 2, reason: "drain" },
    ]);
  });
});

describe("worker pool: index base", () => {
  it("numbers its workers from the base, so every index falls inside the child's block", async () => {
    const s = await setup({ workers: 3, queued: 3, indexBase: 3 });
    expect(s.pool.workers.map((w) => w.id)).toEqual(["host:42:3", "host:42:4", "host:42:5"]);
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 3, "three runs in flight");
    const owners = (await s.running()).map((r) => r.lease!.owner);
    expect(new Set(owners)).toEqual(new Set(["host:42:3", "host:42:4", "host:42:5"]));
    stop.abort();
    s.gates.forEach((g) => g());
    await loops;
  });

  it("without a base the indexes start at 0, as before", async () => {
    const s = await setup({ workers: 2, queued: 0 });
    expect(s.pool.workers.map((w) => w.id)).toEqual(["host:42:0", "host:42:1"]);
  });
});

describe("SF_WORKER_INDEX", () => {
  /** Answers the update run's git calls so the merge is clean, and records the test command's env. */
  class UpdateSandbox extends FakeSandbox {
    testEnvs: Record<string, string>[] = [];
    override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
      const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
      if (cmd[0] !== "git") {
        this.testEnvs.push({ ...(o.env ?? {}) });
        return ok();
      }
      if (cmd[1] === "merge-base") return { ...ok(), exit_code: 1 };
      if (cmd[1] === "merge") return ok();
      return super.exec(h, cmd, o);
    }
  }

  async function poolWith(kind: RunKind, workers: number, indexBase?: number, cpus?: number) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    await store.transition({
      id: item.id, expected_version: 1, patch: { change_ref: "7", allowed_paths: ["docs/"] }, actor: system, reason: "x",
      enqueue: { kind, idempotency_key: kind },
    });
    const sandbox = new UpdateSandbox();
    const runner = new FakeRunner({ triage: (): Partial<AgentRunResult> => ({ output: triageSpec }) });
    const pool = new WorkerPool({
      id_prefix: "host:42", store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock,
      config: { ...config, workers }, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" },
      awake: new NoKeepAwake(),
      ...(indexBase !== undefined ? { index_base: indexBase } : {}),
      ...(cpus !== undefined ? { cpus } : {}),
    });
    return { pool, sandbox, runner, store, item };
  }

  it("reaches the agent's environment as the worker's index", async () => {
    const { pool, runner } = await poolWith("triage", 3);
    // Worker 2 alone claims, so the index is known.
    expect(await pool.workers[2]!.tick()).toBe(true);
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]!.env_allowlist).toMatchObject({ SF_WORKER_INDEX: "2" });
  });

  it("is the base plus the worker's position in the pool", async () => {
    const { pool, runner } = await poolWith("triage", 3, 6);
    expect(await pool.workers[1]!.tick()).toBe(true);
    expect(runner.specs[0]!.env_allowlist).toMatchObject({ SF_WORKER_INDEX: "7" });
  });

  it("reaches the test command's environment in the update run, next to the tool env", async () => {
    const { pool, sandbox, store, item } = await poolWith("update", 2);
    expect(await pool.workers[1]!.tick()).toBe(true);
    expect((await store.listRuns(item.id))[0]).toMatchObject({ status: "succeeded", outcome: { data: { result: "pushed" } } });
    expect(sandbox.testEnvs).toEqual([{ PATH: "/usr/bin", SF_WORKER_INDEX: "1" }]);
  });

  it("with the host's CPUs known, SF_TEST_WORKERS (the CPUs over the claiming slots) reaches the agent and the test command", async () => {
    const triage = await poolWith("triage", 3, undefined, 10);
    expect(await triage.pool.workers[0]!.tick()).toBe(true);
    expect(triage.runner.specs[0]!.env_allowlist).toMatchObject({ SF_WORKER_INDEX: "0", SF_TEST_WORKERS: "3" });
    const update = await poolWith("update", 2, undefined, 10);
    expect(await update.pool.workers[1]!.tick()).toBe(true);
    expect(update.sandbox.testEnvs).toEqual([{ PATH: "/usr/bin", SF_WORKER_INDEX: "1", SF_TEST_WORKERS: "5" }]);
  });
});

describe("testWorkerShare", () => {
  it("splits the CPUs evenly over the slots, rounding down, never below 1", () => {
    expect(testWorkerShare(10, 1)).toBe(10);
    expect(testWorkerShare(10, 3)).toBe(3);
    expect(testWorkerShare(10, 10)).toBe(1);
    expect(testWorkerShare(4, 10)).toBe(1);
    expect(testWorkerShare(1, 1)).toBe(1);
  });

  it("treats zero slots as one", () => {
    expect(testWorkerShare(8, 0)).toBe(8);
  });
});

describe("CountedKeepAwake", () => {
  it("holds on the first hold, releases on the last release, and ignores a release with no hold", async () => {
    const events: string[] = [];
    const awake = new CountedKeepAwake(new RecordingAwake(events));
    await awake.release();
    expect(events).toEqual([]);
    await Promise.all([awake.hold(), awake.hold()]);
    expect(events).toEqual(["hold"]);
    await awake.release();
    expect(events).toEqual(["hold"]);
    await awake.release();
    expect(events).toEqual(["hold", "release"]);
    await awake.hold();
    expect(events).toEqual(["hold", "release", "hold"]);
  });
});
