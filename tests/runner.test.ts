import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker/index.js";
import { DEFAULT_COORDINATION } from "../src/core/coordination.js";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { config, prompts, recordingLog } from "./helpers/fakes/config.js";

const FILE = "src/worker/runner.ts"; // a default hotspot: two items changing it hold each other
const MIN = 60_000;

/** Item `n` implementing FILE, with a queued implement run. */
async function implementing(store: FactoryStore, clock: FakeClock, n: number): Promise<WorkItemId> {
  const { item } = await store.createWorkItem(issue(n), system);
  await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", files_to_change: [FILE], allowed_paths: ["src/worker/"] } });
  await store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: `impl${n}` } });
  clock.advance(1_000);
  return item.id;
}

/** A worker on `store` with the default coordination settings (hold_policy run_after_minutes 120). */
const worker = (store: FactoryStore, clock: FakeClock, log: ReturnType<typeof recordingLog>) => new Worker({
  id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
  clock, config: { ...config, workers: 4, coordination: DEFAULT_COORDINATION }, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {},
  awake: new NoKeepAwake(),
});

describe("run start log of a held implement run (design 05-dependencies, 2026-11-23)", () => {
  it("a run held past the hold limit starts, and its run start log names the timed_out decision and the limit in minutes", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await implementing(store, clock, 1);
    const held = await implementing(store, clock, 2);
    // Item 1's run is left running elsewhere; item 2's run is held behind it.
    expect((await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 }))!.work_item_id).not.toBe(held);
    expect(await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 })).toBeNull();
    clock.advance(120 * MIN);

    const log = recordingLog();
    expect(await worker(store, clock, log).tick()).toBe(true);
    const start = log.lines.find((l) => l.msg === "run start")!;
    expect(start.fields).toMatchObject({ work_item_id: held, kind: "implement", hold_decision: "timed_out", hold_limit_minutes: 120 });
    expect(await store.listClaimDecisions(held)).toMatchObject([{ decision: "timed_out" }]);
  });

  it("an implement run that starts free logs no hold decision", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const lone = await implementing(store, clock, 1);
    const log = recordingLog();
    expect(await worker(store, clock, log).tick()).toBe(true);
    const start = log.lines.find((l) => l.msg === "run start")!;
    expect(start.fields).toMatchObject({ work_item_id: lone, kind: "implement" });
    expect(start.fields?.hold_decision).toBeUndefined();
    expect(start.fields?.hold_limit_minutes).toBeUndefined();
  });
});
