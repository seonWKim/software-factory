import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker/index.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ManualTicks } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage,
  config, prompts, recordingLog, triageSpec, waitFor,
} from "./helpers/fakes.js";

const { lease_ms, heartbeat_ms } = config;
const LATE = "heartbeat late; renewing now";

/**
 * Runs one triage run during which the heartbeat sleeper wakes after `gap` ms, and waits for that renewal: the
 * engine moves the lease to the wake time plus lease_ms.
 */
async function runWithGap(gap: number) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const log = recordingLog();
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });

  const runner = new FakeRunner({
    triage: async (spec) => {
      clock.advance(gap);
      const renewedTo = clock.now().getTime() + lease_ms;
      await waitFor(async () => {
        const run = await store.getRun(spec.run_id);
        return new Date(run!.lease!.expires_at).getTime() === renewedTo;
      }, "lease renewal after the gap");
      return { output: triageSpec };
    },
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
  });

  expect(await worker.tick()).toBe(true);
  const [run] = await store.listRuns(item.id);
  expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
  return { run: run!, late: log.lines.filter((l) => l.msg === LATE) };
}

describe("worker heartbeat: late warning threshold", () => {
  it("does not warn for a gap of heartbeat_ms + 1 (ordinary timer jitter), but still renews", async () => {
    const { late } = await runWithGap(heartbeat_ms + 1);
    expect(late).toHaveLength(0);
  });

  it("warns exactly once for a gap of 2 * heartbeat_ms + 1, with gap_ms equal to the gap, and renews", async () => {
    const gap = 2 * heartbeat_ms + 1;
    const { run, late } = await runWithGap(gap);
    expect(late).toHaveLength(1);
    expect(late[0]!.fields).toMatchObject({ run_id: run.id, gap_ms: gap, lease_ms });
  });
});

describe("worker waits on its ticks plugin", () => {
  it("with the manual plugin, a heartbeat tick renews the lease and a late one records a host sleep, with no clock wait", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const ticks = new ManualTicks();
    const heartbeat = () => ticks.made.find((g) => g.schedules().includes("heartbeat"));
    let release: (() => void) | null = null;
    const runner = new FakeRunner({
      triage: async () => {
        await new Promise<void>((r) => (release = r));
        return { output: triageSpec };
      },
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: recordingLog(), scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
    }, { ticks });
    const done = worker.tick();
    await waitFor(() => heartbeat() !== undefined && release !== null, "the run's agent step and heartbeat schedule");

    // The clock never moves: only the tick's time renews the lease, and its lateness is the host sleep.
    const start = clock.now().getTime();
    const woke = start + 10 * 60_000;
    await heartbeat()!.tick("heartbeat", woke, start + heartbeat_ms);
    const [run] = await store.listRuns(item.id);
    expect(run!.lease!.expires_at).toBe(new Date(woke + lease_ms).toISOString());
    expect(await store.listHostSleeps({ limit: 10 })).toEqual([
      { worker_id: "w1", woke_at: new Date(woke).toISOString(), gap_ms: woke - start - heartbeat_ms, run_id: run!.id },
    ]);
    release!();
    expect(await done).toBe(true);
  });
});
