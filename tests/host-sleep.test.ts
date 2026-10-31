import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { RunId, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  config, prompts, recordingLog, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";

const { lease_ms, heartbeat_ms } = config;

describe("host sleep: worker", () => {
  it("renews at once after a clock jump past lease_ms and completes the run on its first attempt", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const log = recordingLog();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });

    let jumpedNow = 0;
    const runner = new FakeRunner({
      triage: async (spec) => {
        // The host sleeps mid-run: on wake, the clock is far past the lease.
        clock.advance(lease_ms + 25_000);
        jumpedNow = clock.now().getTime();
        // No further clock movement: the heartbeat must land without waiting another heartbeat_ms.
        await waitFor(async () => {
          const run = await store.getRun(spec.run_id);
          return new Date(run!.lease!.expires_at).getTime() === jumpedNow + lease_ms;
        }, "lease renewal after the jump");
        return { output: triageSpec };
      },
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {},
    });

    expect(await worker.tick()).toBe(true);
    const [run] = await store.listRuns(item.id);
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { spec: triageSpec } });
    expect(log.lines.some((l) => l.msg === "lease lost before completion; outcome dropped")).toBe(false);
    const late = log.lines.find((l) => l.msg === "heartbeat late; renewing now");
    expect(late?.fields).toMatchObject({ run_id: run!.id, gap_ms: lease_ms + 25_000 });
  });
});

describe("host sleep: controller reaper grace", () => {
  async function setup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent });
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms }))!;
    const status = async (id: RunId = run.id) => (await store.getRun(id))!.status;
    return { clock, store, controller, item, run, status };
  }

  it("expires nothing on the first tick after its own sleep, then expires an unrenewed lease after heartbeat_ms", async () => {
    const { clock, controller, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect(await status()).toBe("running");

    // Ticks keep being recorded during grace; a small step inside grace does not reset or end it.
    clock.advance(heartbeat_ms - 1);
    await controller.tickReaper();
    expect(await status()).toBe("running");

    clock.advance(1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });

  it("a renewal during grace keeps the run", async () => {
    const { clock, controller, store, run, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect((await store.heartbeat(run.id, run.lease!.token, lease_ms)).ok).toBe(true);
    clock.advance(heartbeat_ms);
    await controller.tickReaper();
    expect(await status()).toBe("running");
  });

  it("a tick that sees no gap is unaffected by the grace", async () => {
    const { clock, controller, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms / 2);
    await controller.tickReaper();
    clock.advance(lease_ms / 2 + 1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });

  it("the first tick of a process has no previous tick and gets no grace", async () => {
    const { clock, controller, status } = await setup();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });
});
