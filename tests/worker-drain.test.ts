import { describe, expect, it, vi } from "vitest";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { runDevChild } from "../src/supervisor.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, config, prompts, silent, triageSpec, waitFor } from "./helpers/fakes.js";

/** A worker over a real (in-memory) store with two queued triage runs; the first blocks until released. */
async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
  await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  const runner = new FakeRunner({
    triage: async () => {
      started++;
      await gate;
      return { output: triageSpec };
    },
  });
  const claimRun = vi.spyOn(store, "claimRun");
  const completeRun = vi.spyOn(store, "completeRun");
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {},
  });
  return { store, worker, release, started: () => started, claimRun, completeRun };
}

describe("worker drain", () => {
  it("a drain during a run lets it finish, completes it with its outcome, and claims nothing after", async () => {
    const { worker, release, started, claimRun, completeRun } = await setup();
    const drain = new AbortController();
    const running = worker.run(drain.signal);
    await waitFor(() => started() === 1, "run in flight");
    const claimsAtDrain = claimRun.mock.calls.length;
    drain.abort();
    release();
    await running;

    expect(completeRun).toHaveBeenCalledTimes(1);
    const outcome = completeRun.mock.calls[0]![2];
    expect(outcome).toMatchObject({ status: "succeeded", data: { spec: triageSpec } });
    expect(await completeRun.mock.results[0]!.value).toEqual({ ok: true });
    expect(claimRun.mock.calls.length).toBe(claimsAtDrain);
    expect(started()).toBe(1);
  });

  it("a drain before a tick claims nothing", async () => {
    const { worker, claimRun } = await setup();
    const drain = new AbortController();
    drain.abort();
    await worker.run(drain.signal);
    expect(claimRun).not.toHaveBeenCalled();
  });
});

describe("dev child: drain over IPC", () => {
  function channel() {
    let onDrain: () => void = () => {};
    const acks: number[] = [];
    return {
      acks,
      drain: () => onDrain(),
      ch: {
        onDrain(cb: () => void) {
          onDrain = cb;
        },
        async acknowledge() {
          acks.push(Date.now());
        },
      },
    };
  }

  it("acknowledges only after the worker's in-flight run completed; the controller runs until then", async () => {
    const { worker, release, started, completeRun, claimRun } = await setup();
    let controllerStopped = false;
    const controller = {
      run: (signal: AbortSignal) =>
        new Promise<void>((r) => signal.addEventListener("abort", () => ((controllerStopped = true), r()), { once: true })),
    };
    const c = channel();
    const stop = new AbortController();
    const child = runDevChild({ controller, worker }, c.ch, stop.signal);
    await waitFor(() => started() === 1, "run in flight");
    const claims = claimRun.mock.calls.length;

    c.drain();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(c.acks).toEqual([]);
    expect(controllerStopped).toBe(false);
    expect(completeRun).not.toHaveBeenCalled();

    release();
    expect(await child).toBe("drained");
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(controllerStopped).toBe(true);
    expect(c.acks).toHaveLength(1);
    expect(claimRun.mock.calls.length).toBe(claims);
  });

  it("the hard stop (SIGTERM) stops both loops and sends no drain acknowledgement", async () => {
    const { worker } = await setup();
    const signals: AbortSignal[] = [];
    const controller = { run: async (s: AbortSignal) => void signals.push(s) };
    const c = channel();
    const stop = new AbortController();
    stop.abort();
    expect(await runDevChild({ controller, worker }, c.ch, stop.signal)).toBe("stopped");
    expect(signals[0]!.aborted).toBe(true);
    expect(c.acks).toEqual([]);
  });
});
