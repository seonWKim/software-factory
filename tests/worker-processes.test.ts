import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { Timestamp } from "../src/core/types.js";
import { WorkerPool } from "../src/core/worker-pool.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, recordingLog, triageSpec, waitFor,
} from "./helpers/fakes.js";

// Each WorkerPool writes one store row per tick: its slots, its slot count and how many slots hold a run
// (design §5 Coordination, 2026-11-07). The row is removed on a clean stop; a dead process's row ages out.

async function setup(opts: { workers: number; queued: number; index_base?: number }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  for (let i = 1; i <= opts.queued; i++) {
    await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
  }
  const gates: (() => void)[] = [];
  let started = 0;
  const runner = new FakeRunner({
    triage: async () => {
      const n = started++;
      await new Promise<void>((r) => (gates[n] = r));
      return { output: triageSpec };
    },
  });
  const cfg: FactoryConfig = { ...config, workers: opts.workers };
  const log = recordingLog();
  const pool = new WorkerPool({
    id_prefix: "host-a:42", store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    ...(opts.index_base !== undefined ? { index_base: opts.index_base } : {}),
  });
  const tick = async () => {
    clock.advance(cfg.tick_ms);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { store, clock, pool, gates, started: () => started, tick, cfg, log };
}

describe("worker processes: the pool's per-process row", () => {
  it("busy is the number of slots holding a run: two runs in progress and one idle slot", async () => {
    const s = await setup({ workers: 3, queued: 2, index_base: 6 });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 2, "two runs in flight");
    await s.tick();
    const [row] = await s.store.listWorkerProcesses(s.cfg.lease_ms);
    expect(row).toEqual({
      process_id: "host-a:42", pid: 42, host: "host-a", slots: 3, max_slots: 3, busy: 2, index_base: 6,
      started_at: expect.any(String), reported_at: s.clock.now().toISOString(),
    });

    // One run ends: the next tick reports one busy slot.
    s.gates[0]!();
    await waitFor(async () => (await s.store.listRunsByStatus(["running"], 10)).length === 1, "one run done");
    await s.tick();
    expect((await s.store.listWorkerProcesses(s.cfg.lease_ms))[0]).toMatchObject({ busy: 1 });

    stop.abort();
    s.gates[1]!();
    await loops;
  });

  it("writes on every tick, replacing its row: reported_at moves, one row per process", async () => {
    const s = await setup({ workers: 2, queued: 0 });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(async () => (await s.store.listWorkerProcesses(s.cfg.lease_ms)).length === 1, "first report");
    const first = (await s.store.listWorkerProcesses(s.cfg.lease_ms))[0]!;
    expect(first).toMatchObject({ slots: 2, max_slots: 2, busy: 0 });
    await s.tick();
    await s.tick();
    const rows = await s.store.listWorkerProcesses(s.cfg.lease_ms);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reported_at > first.reported_at).toBe(true);
    expect(rows[0]!.started_at).toBe(first.started_at);
    stop.abort();
    await loops;
  });

  it("a clean stop removes the process's own row, after the last in-flight run is done", async () => {
    const s = await setup({ workers: 2, queued: 1 });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.started() === 1, "a run in flight");
    await s.store.reportWorkerProcess({
      process_id: "host-b:7", pid: 7, host: "host-b", slots: 1, max_slots: 1, busy: 0, index_base: 0,
      started_at: s.clock.now().toISOString() as Timestamp,
    });
    stop.abort();
    // Draining: still listed, with no claiming slots and its run still held.
    await waitFor(async () => (await s.store.listWorkerProcesses(s.cfg.lease_ms)).some((p) => p.process_id === "host-a:42" && p.slots === 0), "drain report");
    expect((await s.store.listWorkerProcesses(s.cfg.lease_ms)).find((p) => p.process_id === "host-a:42")).toMatchObject({ slots: 0, busy: 1 });
    s.gates[0]!();
    await loops;
    expect((await s.store.listWorkerProcesses(s.cfg.lease_ms)).map((p) => p.process_id)).toEqual(["host-b:7"]);
  });

  it("a row left by a dead process is not listed once its reported_at is older than lease_ms", async () => {
    const s = await setup({ workers: 1, queued: 0 });
    await s.store.reportWorkerProcess({
      process_id: "host-b:7", pid: 7, host: "host-b", slots: 1, max_slots: 1, busy: 1, index_base: 0,
      started_at: s.clock.now().toISOString() as Timestamp,
    });
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(async () => (await s.store.listWorkerProcesses(s.cfg.lease_ms)).length === 2, "both listed");
    // host-b:7 never writes again; the live pool keeps writing each tick.
    const ticks = Math.ceil(s.cfg.lease_ms / s.cfg.tick_ms) + 1;
    for (let i = 0; i < ticks; i++) await s.tick();
    expect((await s.store.listWorkerProcesses(s.cfg.lease_ms)).map((p) => p.process_id)).toEqual(["host-a:42"]);
    stop.abort();
    await loops;
  });

  it("a failed write is logged and the pool keeps running", async () => {
    const s = await setup({ workers: 1, queued: 0 });
    s.store.reportWorkerProcess = async () => {
      throw new Error("no such table: worker_processes");
    };
    const stop = new AbortController();
    const loops = s.pool.run(stop.signal);
    await waitFor(() => s.log.lines.some((l) => l.msg === "worker process report failed"), "warning");
    await s.tick();
    await s.tick();
    // Once per failure streak, not once per tick.
    expect(s.log.lines.filter((l) => l.msg === "worker process report failed")).toHaveLength(1);
    stop.abort();
    await loops;
  });
});
