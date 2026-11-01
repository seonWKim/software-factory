import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig, workerCount } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/log.js";
import type { RunKind } from "../src/core/types.js";
import { CountedKeepAwake, WorkerPool } from "../src/core/worker-pool.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { KeepAwake } from "../src/interfaces/keep-awake.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { runDevChild } from "../src/supervisor.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, recordingLog, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";

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

async function setup(opts: { workers: number; queued: number; awake?: (events: string[]) => KeepAwake; log?: Logger }) {
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
  });
  const running = async () => store.listRunsByStatus(["running"], 100);
  return { store, pool, runner, gates, started, events, running, claimRun, completeRun };
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

  /** A config dir like the checked-in one, on SQLite, with `over` merged in. */
  function root(over: Record<string, unknown>): string {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), "sf-pool-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const plugins = { ...(real.plugins as object), awake: "none" };
    const file = { ...real, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt", ...over };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify(file));
    writeFileSync(join(dir, "secrets.env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
    return dir;
  }

  it("loadConfig carries workers into FactoryConfig (absent: 1) and refuses a bad value", async () => {
    // undefined drops the key, whatever the real config sets.
    expect((await loadConfig(root({ workers: undefined }))).config.workers).toBe(1);
    expect((await loadConfig(root({ workers: 3 }))).config.workers).toBe(3);
    await expect(loadConfig(root({ workers: 0 }))).rejects.toThrow("workers must be an integer of 1 or more");
  });

  it("build() starts `workers` workers in one pool, each with id <host>:<pid>:<n>", async () => {
    const built = await build(await loadConfig(root({ workers: 3 })), { clock: new FakeClock() });
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

  async function poolWith(kind: RunKind, workers: number) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    await store.transition({
      id: item.id, expected_version: 1, patch: { pr_number: 7, allowed_paths: ["docs/"] }, actor: system, reason: "x",
      enqueue: { kind, idempotency_key: kind },
    });
    const sandbox = new UpdateSandbox();
    const runner = new FakeRunner({ triage: (): Partial<AgentRunResult> => ({ output: triageSpec }) });
    const pool = new WorkerPool({
      id_prefix: "host:42", store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock,
      config: { ...config, workers }, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" },
      awake: new NoKeepAwake(),
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

  it("reaches the test command's environment in the update run, next to the tool env", async () => {
    const { pool, sandbox, store, item } = await poolWith("update", 2);
    expect(await pool.workers[1]!.tick()).toBe(true);
    expect((await store.listRuns(item.id))[0]).toMatchObject({ status: "succeeded", outcome: { data: { result: "pushed" } } });
    expect(sandbox.testEnvs).toEqual([{ PATH: "/usr/bin", SF_WORKER_INDEX: "1" }]);
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
