import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { describe, expect, it, vi } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { runDevChild } from "../src/supervisor.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, cleanScanner, config, prompts, recordingLog, silent, triageSpec, waitFor } from "./helpers/fakes.js";

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
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
  });
  return { clock, store, worker, release, started: () => started, claimRun, completeRun };
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
    expect(await completeRun.mock.results[0]!.value).toMatchObject({ ok: true, run: { status: "succeeded" } });
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

  it("a drain stops the controller at once, lets the in-flight run finish, then acknowledges, with no final pass", async () => {
    const { worker, release, started, completeRun, claimRun } = await setup();
    let controllerStopped = false;
    const finalPass: number[] = [];
    const controller = {
      run: (signal: AbortSignal) =>
        new Promise<void>((r) => signal.addEventListener("abort", () => ((controllerStopped = true), r()), { once: true })),
      tickRuns: async () => void finalPass.push(1),
    };
    const c = channel();
    const stop = new AbortController();
    const log = recordingLog();
    const child = runDevChild({ controller, worker }, c.ch, stop.signal, log);
    await waitFor(() => started() === 1, "run in flight");
    const claims = claimRun.mock.calls.length;

    c.drain();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    // The controller stopped before the run finished; the drain waits for the run.
    expect(controllerStopped).toBe(true);
    expect(completeRun).not.toHaveBeenCalled();
    expect(c.acks).toEqual([]);

    release();
    expect(await child).toBe("drained");
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(finalPass).toEqual([]);
    expect(c.acks).toHaveLength(1);
    expect(claimRun.mock.calls.length).toBe(claims);
    expect(log.lines.filter((l) => l.msg.startsWith("controller stopped on drain"))).toHaveLength(1);
  });

  it("the hard stop (SIGTERM) stops both loops and sends no drain acknowledgement", async () => {
    const { worker } = await setup();
    const signals: AbortSignal[] = [];
    const controller = { run: async (s: AbortSignal) => void signals.push(s), tickRuns: async () => {} };
    const c = channel();
    const stop = new AbortController();
    stop.abort();
    expect(await runDevChild({ controller, worker }, c.ch, stop.signal)).toBe("stopped");
    expect(signals[0]!.aborted).toBe(true);
    expect(c.acks).toEqual([]);
  });
});

describe("dev child: two children through a swap", () => {
  function channel() {
    let onDrain: () => void = () => {};
    const acks: number[] = [];
    return { acks, drain: () => onDrain(), ch: { onDrain: (cb: () => void) => void (onDrain = cb), acknowledge: async () => void acks.push(1) } };
  }
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  /** Counts each controller step a pass runs, so a test sees whether a pass started. */
  function countSteps(c: Controller) {
    const steps = ["intake", "reaperStep", "checksStep", "coordinationStep", "commandsStep", "runsStep", "probeStep", "outboxStep"] as const;
    const spies = steps.map((s) => vi.spyOn(c as unknown as Record<string, () => Promise<void>>, s));
    return () => Object.fromEntries(steps.map((s, i) => [s, spies[i]!.mock.calls.length])) as Record<(typeof steps)[number], number>;
  }

  it("the old controller makes no pass after the drain; its run completes; the new controller applies the outcome", async () => {
    const { clock, store, worker: oldWorker, release, started, completeRun } = await setup();
    const controllerOf = (log = silent) =>
      new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, repeated_failure_rule: false });
    const oldLog = recordingLog();
    const oldController = controllerOf(oldLog);
    const oldSteps = countSteps(oldController);
    const oldChannel = channel();
    const oldStop = new AbortController();
    const oldChild = runDevChild({ controller: oldController, worker: oldWorker }, oldChannel.ch, oldStop.signal, oldLog);
    await waitFor(() => started() === 1, "old child's run in flight");
    await waitFor(() => oldSteps().probeStep >= 1, "old controller's first pass");
    await flush();
    const item = (await store.getWorkItemBySource("github_issue", "o/r#1"))!;
    const before = item.stage;

    // The swap: the new child starts first, then the old one is asked to drain.
    const newController = controllerOf();
    const newSteps = countSteps(newController);
    const newWorker = { run: (s: AbortSignal) => new Promise<void>((r) => s.addEventListener("abort", () => r(), { once: true })) };
    const newChannel = channel();
    const newStop = new AbortController();
    const newChild = runDevChild({ controller: newController, worker: newWorker }, newChannel.ch, newStop.signal);
    await waitFor(() => newSteps().probeStep >= 1, "new controller's first pass");
    const atDrain = oldSteps();
    oldChannel.drain();
    await flush();
    expect(oldLog.lines.filter((l) => l.msg.startsWith("controller stopped on drain"))).toHaveLength(1);

    // Ticks pass: the new controller keeps running, the old one starts nothing.
    for (let i = 0; i < 3; i++) {
      clock.advance(config.tick_ms);
      await flush();
    }
    expect(oldSteps()).toEqual(atDrain);
    expect(completeRun).not.toHaveBeenCalled();

    // The old child's run finishes after the drain; the old child acknowledges without a pass of its own.
    release();
    expect(await oldChild).toBe("drained");
    expect(oldChannel.acks).toHaveLength(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(await completeRun.mock.results[0]!.value).toMatchObject({ ok: true, run: { status: "succeeded" } });
    expect(oldSteps()).toEqual(atDrain);
    expect((await store.getWorkItem(item.id))!.stage).toBe(before);

    // The new child's next pass applies the outcome.
    const passes = newSteps().runsStep;
    clock.advance(config.tick_ms);
    await waitFor(() => newSteps().runsStep > passes, "new controller's next pass");
    await waitFor(async () => (await store.getWorkItem(item.id))!.stage !== before, "outcome applied");
    expect(oldSteps()).toEqual(atDrain);
    expect(oldLog.lines.filter((l) => l.msg.startsWith("controller stopped on drain"))).toHaveLength(1);

    newStop.abort();
    expect(await newChild).toBe("stopped");
  });
});
