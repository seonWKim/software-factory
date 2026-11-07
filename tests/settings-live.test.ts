import { describe, expect, it, vi } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { DEFAULT_MODEL_TABLE } from "../src/core/model-choice.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { Run, WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { WorkerPool } from "../src/core/worker-pool.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PROJECT_KEY, issue, newStore, system, w2 } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config as baseConfig, issueRef, prompts, recordingLog, settingsWith, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";

// Design 2026-11-03, "Settings change at runtime": each settable key takes effect at the point its row gives,
// with no restart. Every override here is written to the store, as `factory settings set` does, and read back
// by the running controller and worker through LiveSettings.

type Fn = (spec: AgentRunSpec) => Partial<AgentRunResult>;
const NAMES = { cheap: "file-cheap", standard: "file-standard", strong: "file-strong" };

async function harness(opts: { triage?: Fn; implement?: Fn; review?: Fn; config?: Partial<FactoryConfig> } = {}) {
  const config: FactoryConfig = { ...baseConfig, dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 }, ...opts.config };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const runner = new FakeRunner({
    triage: opts.triage ?? (() => ({ output: triageSpec })),
    implement: opts.implement ?? (() => ({ output: { summary: "s", next_steps: "n" } })),
    review: opts.review ?? (() => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } })),
  });
  const log = recordingLog();
  const settings = new LiveSettings({ config, base: baseFromConfig(config, { table: DEFAULT_MODEL_TABLE, names: NAMES }), source: store, log });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, settings, repeated_failure_rule: false });
  const w1 = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
  });
  const set = (key: string, value: unknown, project = "") =>
    store.setSettingOverride({ key, project, value: JSON.stringify(value), actor: "local:test" });
  let n = 0;
  const submit = async () => {
    n++;
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  const item = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const runs = async (it: WorkItem, kind?: Run["kind"]) => (await store.listRuns(it.id)).filter((r) => !kind || r.kind === kind);
  /** Runs triage and lets the controller queue the implement run. */
  const toImplement = async () => {
    const it0 = await submit();
    expect(await w1.tick()).toBe(true);
    await controller.tickRuns();
    return it0;
  };
  return { config, clock, store, source, sandbox, runner, log, settings, controller, w1, set, submit, item, runs, toImplement };
}

const failed: Fn = () => ({ status: "failed", error: "boom", transcript: "t" });
const iso = (ms: number) => new Date(ms).toISOString();

describe("retry, attempt and loop keys apply at the controller's next decision", () => {
  it("max_attempts", async () => {
    const h = await harness({ triage: failed });
    const it0 = await h.submit();
    await h.w1.tick();
    await h.set("max_attempts", 1);
    await h.controller.tickRuns();
    expect(await h.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
  });

  it("max_attempts per project", async () => {
    const h = await harness({ triage: failed });
    const it0 = await h.submit();
    await h.w1.tick();
    await h.set("max_attempts", 1, PROJECT_KEY);
    await h.controller.tickRuns();
    expect((await h.item(it0)).blocked_on).toBe("human");
  });

  it("max_restart", async () => {
    const h = await harness({ triage: () => { throw new Error("harness crashed"); } });
    const it0 = await h.submit();
    await h.w1.tick();
    await h.set("max_restart", 1);
    await h.controller.tickRuns();
    expect(await h.item(it0)).toMatchObject({ blocked_on: "human" });
    expect((await h.runs(it0)).map((r) => r.status)).toEqual(["failed"]);
  });

  it("retry_base_ms", async () => {
    const h = await harness({ triage: failed });
    const it0 = await h.submit();
    await h.w1.tick();
    const failedAt = h.clock.now().getTime();
    await h.set("retry_base_ms", 5_000);
    await h.controller.tickRuns();
    expect((await h.runs(it0)).at(-1)).toMatchObject({ status: "queued", not_before: iso(failedAt + 5_000) });
  });

  it("retry_max_ms", async () => {
    const h = await harness({ triage: failed, config: { settings: settingsWith({ max_attempts: 5 }) } });
    const it0 = await h.submit();
    await h.w1.tick();
    await h.controller.tickRuns();
    h.clock.advance(h.config.retry_base_ms);
    await h.w1.tick();
    const failedAt = h.clock.now().getTime();
    // The second wait would be 2 × retry_base_ms; the new cap cuts it.
    await h.set("retry_max_ms", 61_000);
    await h.controller.tickRuns();
    expect((await h.runs(it0)).at(-1)).toMatchObject({ status: "queued", not_before: iso(failedAt + 61_000) });
  });

  it("max_loops", async () => {
    const h = await harness({ review: () => ({ output: { verdict: "bug", tier: 2, findings: ["off by one"], summary: "s" } }) });
    const it0 = await h.toImplement();
    await h.w1.tick(); // implement
    await h.controller.tickRuns();
    await h.w1.tick(); // review finds a bug
    await h.set("max_loops", 1);
    await h.controller.tickRuns();
    expect((await h.item(it0)).blocked_on).toBe("human");
    expect(h.source.comments.some((c) => c.body.includes("(limit 1)"))).toBe(true);
  });
});

describe("diff, timeout and model keys apply at the next run that starts", () => {
  it("max_diff_lines (global and per project)", async () => {
    for (const project of ["", PROJECT_KEY]) {
      const h = await harness();
      h.sandbox.numstat = "100\t0\tdocs/a.md\0";
      const it0 = await h.toImplement();
      await h.set("max_diff_lines", 50, project);
      await h.w1.tick();
      expect((await h.runs(it0, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "diff_too_large" });
    }
  });

  it("max_diff_files", async () => {
    const h = await harness();
    h.sandbox.numstat = "1\t0\tdocs/a.md\x001\t0\tdocs/b.md\x001\t0\tdocs/c.md\0";
    const it0 = await h.toImplement();
    await h.set("max_diff_files", 2);
    await h.w1.tick();
    expect((await h.runs(it0, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "diff_too_large" });
  });

  it("run_timeout_ms", async () => {
    const h = await harness();
    await h.toImplement();
    expect(h.runner.specs.at(-1)!.timeout_ms).toBe(h.config.run_timeout_ms);
    await h.set("run_timeout_ms", 1234);
    await h.w1.tick();
    expect(h.runner.specs.at(-1)).toMatchObject({ role: "implement", timeout_ms: 1234 });
  });

  it("first_output_ms", async () => {
    const h = await harness();
    await h.toImplement();
    expect(h.runner.specs.at(-1)!.first_output_ms).toBe(180_000);
    await h.set("first_output_ms", 4321);
    await h.w1.tick();
    expect(h.runner.specs.at(-1)).toMatchObject({ role: "implement", first_output_ms: 4321 });
  });

  it("run_timeout_ms set during a run does not change that run", async () => {
    let setDuring: Promise<unknown> | null = null;
    const h = await harness({
      implement: () => {
        setDuring = h.set("run_timeout_ms", 999);
        return { output: { summary: "s", next_steps: "n" } };
      },
    });
    const it0 = await h.toImplement();
    await h.w1.tick();
    await setDuring;
    expect(h.runner.specs.at(-1)!.timeout_ms).toBe(h.config.run_timeout_ms);
    expect((await h.runs(it0, "implement"))[0]!.status).toBe("succeeded");
  });

  it("models", async () => {
    const h = await harness();
    const it0 = await h.submit();
    await h.set("models", { cheap: "live-cheap", standard: "live-standard", strong: "live-strong" });
    await h.w1.tick();
    expect((await h.runs(it0, "triage"))[0]!.outcome).toMatchObject({ data: { model_class: "cheap", model: "live-cheap" } });
  });

  it("model_by", async () => {
    const h = await harness();
    await h.submit();
    await h.set("model_by", { triage: "strong" });
    await h.w1.tick();
    expect(h.runner.specs.at(-1)).toMatchObject({ role: "triage", model_class: "strong" });
  });
});

describe("poll, tick, heartbeat and lease keys apply at the next tick or lease renewal", () => {
  it("poll_interval_ms", async () => {
    const h = await harness();
    const stop = new AbortController();
    const loop = h.controller.run(stop.signal);
    await waitFor(() => h.source.polls.length === 1, "first poll");
    h.clock.advance(h.config.tick_ms);
    await waitFor(async () => (await h.store.getClaimPause()) === null, "a tick");
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(h.source.polls).toHaveLength(1);
    await h.set("poll_interval_ms", h.config.tick_ms);
    h.clock.advance(h.config.tick_ms);
    await waitFor(() => h.source.polls.length === 2, "poll on the next tick");
    stop.abort();
    await loop;
  });

  it("tick_ms", async () => {
    const h = await harness();
    const claims = vi.spyOn(h.store, "claimRun");
    const stop = new AbortController();
    const loop = h.w1.run(stop.signal);
    await waitFor(() => claims.mock.calls.length === 1, "first claim");
    await h.set("tick_ms", 100);
    // The sleep in progress keeps the old value; the next one uses the new.
    h.clock.advance(h.config.tick_ms);
    await waitFor(() => claims.mock.calls.length === 2, "second claim");
    h.clock.advance(100);
    await waitFor(() => claims.mock.calls.length === 3, "claim after the new tick_ms");
    stop.abort();
    await loop;
  });

  it("heartbeat_ms and lease_ms: the next renewal uses both", async () => {
    let release: () => void = () => {};
    const h = await harness();
    h.runner.script.triage = async () => {
      await new Promise<void>((r) => (release = r));
      return { output: triageSpec };
    };
    const beats = vi.spyOn(h.store, "heartbeat");
    const it0 = await h.submit();
    const tick = h.w1.tick();
    await waitFor(async () => (await h.runs(it0))[0]?.status === "running", "run claimed");
    const claimed = (await h.runs(it0))[0]!;
    expect(claimed.lease!.expires_at).toBe(iso(h.clock.now().getTime() + h.config.lease_ms));

    await h.set("lease_ms", 40_000);
    await h.set("heartbeat_ms", 2_000);
    // The renewal at the old heartbeat_ms extends by the new lease_ms.
    h.clock.advance(h.config.heartbeat_ms);
    await waitFor(() => beats.mock.calls.length === 1, "renewal");
    expect(beats.mock.calls[0]![2]).toBe(40_000);
    const renewedAt = h.clock.now().getTime();
    await waitFor(async () => (await h.runs(it0))[0]!.lease?.expires_at === iso(renewedAt + 40_000), "renewal stored");
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    // The next renewal comes after the new heartbeat_ms, not the old one.
    h.clock.advance(2_000);
    await waitFor(() => beats.mock.calls.length === 2, "renewal at the new heartbeat_ms");
    release();
    await tick;
  });

  it("lease_ms: the next claim takes a lease of the new length", async () => {
    const h = await harness();
    const it0 = await h.submit();
    await h.set("lease_ms", 45_000);
    const claim = vi.spyOn(h.store, "claimRun");
    await h.w1.tick();
    expect(claim.mock.calls[0]![0].lease_ms).toBe(45_000);
    expect((await h.runs(it0))[0]!.status).toBe("succeeded");
  });
});

describe("workers: the pool grows and shrinks with no restart", () => {
  /** A gate per run, opened by the test. */
  function gated() {
    const gates: (() => void)[] = [];
    let started = 0;
    const runner = new FakeRunner({
      triage: async () => {
        const n = started++;
        await new Promise<void>((r) => (gates[n] = r));
        return { output: triageSpec };
      },
    });
    return { runner, gates, started: () => started };
  }

  it("5 workers, set 2: two slots keep claiming, three finish their run and stop within one tick; set 5: they claim again", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    for (let i = 1; i <= 5; i++) await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
    const { runner, gates, started } = gated();
    const claims = vi.spyOn(store, "claimRun");
    const config: FactoryConfig = { ...baseConfig, workers: 5 };
    const settings = new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent });
    const pool = new WorkerPool({
      id_prefix: "host:42", store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
    });
    const set = (v: number) => store.setSettingOverride({ key: "workers", project: "", value: String(v), actor: "local:test" });
    const claimers = (from: number) => new Set(claims.mock.calls.slice(from).map((c) => c[0].worker_id));
    const stop = new AbortController();
    const loops = pool.run(stop.signal);
    await waitFor(() => started() === 5, "five runs in flight");
    expect(pool.size()).toBe(5);

    await set(2);
    clock.advance(baseConfig.tick_ms); // one tick
    await waitFor(() => pool.size() === 2, "pool sees workers = 2");
    for (const g of gates) g(); // every in-flight run finishes
    await waitFor(async () => (await store.listRunsByStatus(["succeeded"], 10)).length === 5, "all five runs done");
    const mark = claims.mock.calls.length;
    for (let i = 6; i <= 9; i++) await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
    clock.advance(baseConfig.tick_ms);
    await waitFor(() => started() === 7, "slots 0 and 1 claim two of the four");
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(started()).toBe(7);
    expect(await store.listRunsByStatus(["running"], 10)).toHaveLength(2);
    for (const g of gates) g();
    await waitFor(() => started() === 9, "the same two slots claim the other two");
    for (const g of gates) g();
    await waitFor(async () => (await store.listRunsByStatus(["succeeded"], 20)).length === 9, "all nine runs done");
    expect(claimers(mark)).toEqual(new Set(["host:42:0", "host:42:1"]));

    // Back to 5: the three stopped slots claim again.
    await set(5);
    for (let i = 10; i <= 14; i++) await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
    const mark2 = claims.mock.calls.length;
    const before = started();
    clock.advance(baseConfig.tick_ms);
    await waitFor(() => pool.size() === 5, "pool sees workers = 5");
    await waitFor(() => started() >= before + 5, "five runs in flight again");
    expect(claimers(mark2)).toEqual(new Set(["host:42:0", "host:42:1", "host:42:2", "host:42:3", "host:42:4"]));

    stop.abort();
    for (const g of gates) g();
    await loops;
  });

  it("a stored workers above the file's value is capped at it", async () => {
    const { store } = await newStore();
    await store.setSettingOverride({ key: "workers", project: "", value: "9", actor: "local:test" });
    const config: FactoryConfig = { ...baseConfig, workers: 3 };
    const settings = new LiveSettings({ config, base: baseFromConfig(config), source: store });
    await settings.refresh();
    const pool = new WorkerPool({
      id_prefix: "h:1", store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
      clock: new FakeClock(), config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
    });
    expect(pool.size()).toBe(3);
    expect(pool.workers).toHaveLength(3);
  });

  it("hold_policy: set to run, the worker's next claim takes a run held by cost; reset, it holds again", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const ids = [];
    for (const n of [1, 2, 3]) {
      const { item } = await store.createWorkItem(issue(n), system);
      await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", files_to_change: ["src/core/worker.ts"] } });
      await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `${n}` } });
      ids.push(item.id);
      clock.advance(1_000);
    }
    // Item 1 runs on another worker; 2 and 3 are held by it.
    expect(await store.claimRun({ worker_id: w2, kinds: ["implement"], lease_ms: 60_000 })).toMatchObject({ work_item_id: ids[0] });
    // The worker's claims go to the store; the claimed run is recorded, not executed.
    const claimed: (Run | null)[] = [];
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "claimRun") {
          return async (input: Parameters<FactoryStore["claimRun"]>[0]) => {
            claimed.push(await target.claimRun(input));
            return null;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const settings = new LiveSettings({ config: baseConfig, base: baseFromConfig(baseConfig), source: store });
    const worker = new Worker({
      id: "w1" as WorkerId, store: spy, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(),
      storage: new MemoryStorage(), clock, config: baseConfig, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
    });
    await worker.tick();
    expect(claimed.at(-1)).toBeNull();
    await store.setSettingOverride({ key: "hold_policy", project: "", value: JSON.stringify({ mode: "run" }), actor: "local:test" });
    await worker.tick();
    expect(claimed.at(-1)).toMatchObject({ work_item_id: ids[1] });
    expect((await store.listClaimDecisions(ids[1]!))[0]).toMatchObject({ decision: "overlap_allowed", holder_work_item_id: ids[0] });
    await store.resetSettingOverride({ key: "hold_policy", project: "", actor: "local:test" });
    await worker.tick();
    expect(claimed.at(-1)).toBeNull();
    expect((await store.listClaimDecisions(ids[2]!))[0]).toMatchObject({ decision: "held" });
  });
});
