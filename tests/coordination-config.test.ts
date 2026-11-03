import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { coordinationConfig } from "../src/core/config.js";
import type { RunKind, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, silent } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

type ClaimInput = Parameters<FactoryStore["claimRun"]>[0];
const HOTSPOT = "src/core/worker.ts";
const ALL: RunKind[] = ["triage", "implement", "review", "update", "resolve"];

/** The claim input one worker tick sends, with `coordination` set from the config or left out. */
async function claimInputOf(cfg: FactoryConfig): Promise<ClaimInput> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  let seen: ClaimInput | undefined;
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "claimRun") {
        return async (input: ClaimInput) => {
          seen = input;
          return null;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store: spy, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(),
    storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  expect(await worker.tick()).toBe(false);
  return seen!;
}

describe("max_coordination_cost reaches the claim (design §5, 2026-11-03)", () => {
  it("the worker passes config.coordination to claimRun, and leaves it out when the config has none", async () => {
    const coordination = coordinationConfig({ max_coordination_cost: 10 });
    expect((await claimInputOf({ ...config, coordination })).coordination).toEqual(coordination);
    expect((await claimInputOf(config)).coordination).toBeUndefined();
  });

  it("a threshold read from the config changes the claim: two items sharing a hotspot run in parallel at 10, not at 2.5", async () => {
    for (const [raw, both] of [[{}, false], [{ max_coordination_cost: 10 }, true]] as const) {
      const clock = new FakeClock();
      const { store } = await newStore(clock);
      for (const n of [1, 2]) {
        const { item } = await store.createWorkItem(issue(n), system);
        await store.transition({
          id: item.id, expected_version: 1, actor: system, reason: "x",
          patch: { stage: "RUNNING", tier: 2, allowed_paths: ["src/"], files_to_change: [HOTSPOT] },
        });
        await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `${n}` } });
        clock.advance(1_000);
      }
      const input = { worker_id: w1, kinds: ALL, lease_ms: 60_000, coordination: coordinationConfig(raw) };
      expect(await store.claimRun(input)).not.toBeNull();
      expect((await store.claimRun(input)) !== null).toBe(both);
    }
  });
});
