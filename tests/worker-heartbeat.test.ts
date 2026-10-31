import { describe, expect, it, vi } from "vitest";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage,
  config, prompts, recordingLog, triageSpec, waitFor,
} from "./helpers/fakes.js";

const { lease_ms, heartbeat_ms } = config;
const LATE = "heartbeat late; renewing now";

/** Runs one triage run during which the heartbeat sleeper wakes after `gap` ms, and waits for that renewal. */
async function runWithGap(gap: number) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const heartbeats = vi.spyOn(store, "heartbeat");
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
  return { run: run!, late: log.lines.filter((l) => l.msg === LATE), heartbeats: heartbeats.mock.calls.length };
}

describe("worker heartbeat: late warning threshold", () => {
  it("does not warn for a gap of heartbeat_ms + 1 (ordinary timer jitter), but still renews", async () => {
    const { late, heartbeats } = await runWithGap(heartbeat_ms + 1);
    expect(late).toHaveLength(0);
    expect(heartbeats).toBe(1);
  });

  it("warns exactly once for a gap of 2 * heartbeat_ms + 1, with gap_ms equal to the gap, and renews", async () => {
    const gap = 2 * heartbeat_ms + 1;
    const { run, late, heartbeats } = await runWithGap(gap);
    expect(late).toHaveLength(1);
    expect(late[0]!.fields).toMatchObject({ run_id: run.id, gap_ms: gap, lease_ms });
    expect(heartbeats).toBe(1);
  });
});
