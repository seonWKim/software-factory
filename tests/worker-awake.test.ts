import { describe, expect, it, vi } from "vitest";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { KeepAwake } from "../src/interfaces/keep-awake.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, config, prompts, recordingLog, triageSpec } from "./helpers/fakes.js";

/** Writes hold/release into the same list the runner writes to, so the order is visible. */
class RecordingAwake implements KeepAwake {
  constructor(private readonly events: string[]) {}
  async hold(): Promise<void> {
    this.events.push("hold");
  }
  async release(): Promise<void> {
    this.events.push("release");
  }
}

type Triage = () => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>;

async function setup(triage: Triage, awake: (events: string[]) => KeepAwake, opts: { enqueue?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const events: string[] = [];
  const log = recordingLog();
  const { item } = await store.createWorkItem(issue(1), system, opts.enqueue === false ? {} : { enqueue: { kind: "triage", idempotency_key: "t" } });
  const runner = new FakeRunner({
    triage: async () => {
      events.push("run");
      return triage();
    },
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: awake(events),
  });
  const status = async () => (await store.listRuns(item.id))[0]?.status;
  return { worker, events, status, log };
}

describe("worker: keep awake around each claimed run", () => {
  it("holds before the agent runs and releases after a successful run", async () => {
    const s = await setup(() => ({ output: triageSpec }), (e) => new RecordingAwake(e));
    expect(await s.worker.tick()).toBe(true);
    expect(s.events).toEqual(["hold", "run", "release"]);
    expect(await s.status()).toBe("succeeded");
  });

  it("releases after a run whose agent throws", async () => {
    const s = await setup(() => {
      throw new Error("agent crashed");
    }, (e) => new RecordingAwake(e));
    expect(await s.worker.tick()).toBe(true);
    expect(s.events).toEqual(["hold", "run", "release"]);
    expect(await s.status()).toBe("failed");
  });

  it("releases after a run whose agent returns a failed status", async () => {
    const s = await setup(() => ({ status: "failed", error: "boom" }), (e) => new RecordingAwake(e));
    expect(await s.worker.tick()).toBe(true);
    expect(s.events).toEqual(["hold", "run", "release"]);
    expect(await s.status()).toBe("failed");
  });

  it("never holds when there is no run to claim", async () => {
    const s = await setup(() => ({ output: triageSpec }), (e) => new RecordingAwake(e), { enqueue: false });
    expect(await s.worker.tick()).toBe(false);
    expect(s.events).toEqual([]);
  });

  it("a KeepAwake that throws anyway is logged, and the run still completes", async () => {
    const s = await setup(() => ({ output: triageSpec }), (e) => ({
      hold: async () => {
        e.push("hold");
        throw new Error("no power assertion");
      },
      release: async () => {
        e.push("release");
        throw new Error("gone");
      },
    }));
    expect(await s.worker.tick()).toBe(true);
    expect(s.events).toEqual(["hold", "run", "release"]);
    expect(await s.status()).toBe("succeeded");
    expect(s.log.lines.filter((l) => l.level === "warn").map((l) => l.msg)).toEqual(["keep-awake hold failed", "keep-awake release failed"]);
  });

  it("works with the none plugin: hold before the run, release after", async () => {
    const none = new NoKeepAwake();
    const s = await setup(() => ({ output: triageSpec }), (e) => {
      vi.spyOn(none, "hold").mockImplementation(async () => void e.push("hold"));
      vi.spyOn(none, "release").mockImplementation(async () => void e.push("release"));
      return none;
    });
    expect(await s.worker.tick()).toBe(true);
    expect(s.events).toEqual(["hold", "run", "release"]);
    expect(await s.status()).toBe("succeeded");
  });
});
