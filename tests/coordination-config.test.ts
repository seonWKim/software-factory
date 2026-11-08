import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";
import { ConfigKeyError, checkConfigKeys } from "../src/config-keys.js";
import type { FactoryConfig } from "../src/core/config.js";
import { coordinationConfig } from "../src/core/config.js";
import { DEFAULT_COORDINATION } from "../src/core/coordination.js";
import { runSettings } from "../src/settings-cmd.js";
import type { RunKind, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
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

describe("hold_policy and hotspot_mode at config load (issue #314)", () => {
  const problems = (raw: Record<string, unknown>): readonly string[] => {
    try {
      checkConfigKeys(raw);
      return [];
    } catch (err) {
      return err instanceof ConfigKeyError ? err.problems : [String(err)];
    }
  };
  const BAD_POLICIES: unknown[] = [
    { mode: "later" },
    "run",
    { mode: "run_after_minutes", minutes: 0 },
    { mode: "run_after_minutes", minutes: 1.5 },
    { mode: "run_after_minutes", minutes: "20" },
    { mode: "hold", minutes: 5 },
  ];

  it("an unknown mode or minutes that is not a positive integer fails", () => {
    for (const hold_policy of BAD_POLICIES) {
      expect(problems({ hold_policy }), JSON.stringify(hold_policy)).toEqual([expect.stringMatching(/^hold_policy/)]);
      expect(() => coordinationConfig({ hold_policy })).toThrow(/hold_policy/);
    }
  });

  it("an unknown hotspot_mode fails", () => {
    expect(problems({ hotspot_mode: "soft" })).toEqual([expect.stringMatching(/^hotspot_mode must be "policy" or "hold"/)]);
  });

  it("valid values load; run_after_minutes without minutes means 20; absent keys take the defaults", () => {
    expect(problems({ hold_policy: { mode: "run" }, hotspot_mode: "hold" })).toEqual([]);
    expect(coordinationConfig({ hold_policy: { mode: "run_after_minutes" } }).hold_policy).toEqual({ mode: "run_after_minutes", minutes: 20 });
    expect(coordinationConfig({})).toMatchObject({ hold_policy: { mode: "hold" }, hotspot_mode: "policy" });
  });

  it("factory settings set refuses the same values and accepts a valid one", async () => {
    const { store } = await newStore(new FakeClock());
    const deps = { store, base: { file: {}, layers: { defaults: {}, projects: {} } }, repo: { owner: "o", name: "r" }, resolveProject: async () => ({ key: "k", label: "l" }), actor: "local:owner" };
    for (const v of BAD_POLICIES) {
      const r = await runSettings(deps, { action: "set", key: "hold_policy", value: JSON.stringify(v) });
      expect(r, JSON.stringify(v)).toMatchObject({ ok: false, lines: [expect.stringMatching(/^refused: hold_policy/)] });
    }
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await runSettings(deps, { action: "set", key: "hold_policy", value: '{"mode":"run_after_minutes","minutes":30}' })).toMatchObject({ ok: true });
    expect((await store.listSettingOverrides()).map((o) => o.key)).toContain("hold_policy");
  });
});

describe("factory.config.json coordination keys reach the claim (issue #314)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("max_coordination_cost, hotspot_weight, hotspot_paths, hold_policy and hotspot_mode go from the file to claimRun", async () => {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), "sf-coordination-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const keys = {
      max_coordination_cost: 7, hotspot_weight: 4, hotspot_paths: ["lib/hot.ts"],
      hold_policy: { mode: "run_after_minutes", minutes: 5 }, hotspot_mode: "hold",
    };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...real, ...keys }));
    writeFileSync(join(dir, ".secrets"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, ".secrets"));
    const { config: loaded } = await loadConfig(dir);
    const expected = {
      ...DEFAULT_COORDINATION, max_cost: 7, hotspot_weight: 4, hotspots: ["lib/hot.ts"],
      hold_policy: { mode: "run_after_minutes", minutes: 5 }, hotspot_mode: "hold",
    };
    expect(loaded.coordination).toEqual(expected);
    expect((await claimInputOf({ ...config, coordination: loaded.coordination! })).coordination).toEqual(expected);
  });
});
