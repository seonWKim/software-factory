// The runtime `integrations` setting (design 08-settings, 2026-11-12): it switches only an interface marked
// `integration` (the tacit ledger) to a registered plugin, over factory.config.json's choice, with no restart. The
// controller and the worker pool see a change by their next tick through the live holder LiveSettings refreshes.
// Every ledger here is a fake: no test runs the real tacit or evolve CLI.

import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { LearnedRules } from "../src/core/learned-rules.js";
import { LiveSettings, baseFromConfig, keyRefusal, parseSettable } from "../src/core/settings.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { TacitLedger } from "../src/interfaces/tacit-ledger.js";
import { REGISTRY, checkIntegrations, createPlugin, withPlugin } from "../src/plugins.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { LiveTacit } from "../src/runtime/live-tacit.js";
import { type SettingsDeps, runSettings } from "../src/settings-cmd.js";
import { WorkerPool } from "../src/worker/index.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, cleanScanner, config, prompts, silent,
} from "./helpers/fakes.js";

/** A ledger that is on and lists one entry named after it. */
const fakeLedger = (name: string): TacitLedger => ({
  enabled: true,
  capture: async () => {},
  pending: async () => [{ id: "C-1", title: name, state: "pending" }],
  verdict: async () => {},
  rules: async () => [{ id: "C-1", name, default: `rule from ${name}`, exceptions: "", scope: "" }],
});

/** The registry with a fake tacit plugin `fake`, and a build through it, as compose.ts builds the holder. */
const registry = withPlugin(REGISTRY, "tacit", "fake", () => fakeLedger("fake"));
const build = (name: string) => createPlugin(registry, "tacit", name, {} as never);

async function setup(configured = "none") {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const tacit = await LiveTacit.start(configured, build, silent);
  const settings = new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent, integrations: [tacit] });
  const set = (value: unknown) => store.setSettingOverride({ key: "integrations", project: "", value: JSON.stringify(value), actor: "local:owner" });
  const reset = () => store.resetSettingOverride({ key: "integrations", project: "", actor: "local:owner" });
  return { clock, store, tacit, settings, set, reset };
}

describe("integrations: the registry check", () => {
  it("takes an integration interface and one of its registered plugins", () => {
    expect(checkIntegrations(REGISTRY, { tacit: "agents-home" })).toEqual({ tacit: "agents-home" });
    expect(checkIntegrations(REGISTRY, {})).toEqual({});
  });

  it("refuses a guard, any other interface, an unknown interface and an unknown plugin name", () => {
    for (const guard of ["secrets", "egress", "broker"]) {
      expect(() => checkIntegrations(REGISTRY, { [guard]: "x" }), guard).toThrow(/is a guard/);
    }
    expect(() => checkIntegrations(REGISTRY, { runner: "claude-code" })).toThrow(/AgentRunner \(runner\) is not an integration/);
    expect(() => checkIntegrations(REGISTRY, { teapot: "x" })).toThrow(/unknown interface "teapot"/);
    expect(() => checkIntegrations(REGISTRY, { tacit: "nope" })).toThrow(/integrations: unknown TacitLedger plugin "nope" for tacit/);
    expect(() => checkIntegrations(REGISTRY, ["tacit"])).toThrow(/must be an object/);
  });

  it("is a runtime key; the stored shape is an object of plugin names", () => {
    expect(keyRefusal("integrations")).toBeNull();
    expect(parseSettable("integrations", { tacit: "agents-home" })).toEqual({ tacit: "agents-home" });
    expect(() => parseSettable("integrations", { tacit: "" })).toThrow(/plugin name/);
    expect(() => parseSettable("integrations", "agents-home")).toThrow(/must be an object/);
  });
});

describe("integrations: settings set", () => {
  async function deps(over: Partial<SettingsDeps> = {}) {
    const { store } = await newStore(new FakeClock());
    const d: SettingsDeps = {
      store, base: baseFromConfig(config), repo: config.repo, actor: "local:owner",
      resolveProject: async () => ({ key: "p", label: "p" }), ...over,
    };
    return { d, store };
  }

  it("a refused set writes no override and no audit row", async () => {
    const { d, store } = await deps();
    for (const value of [{ secrets: "env-file" }, { broker: "github" }, { egress: "pattern" }, { runner: "claude-code" }, { tacit: "nope" }, { teapot: "x" }]) {
      const r = await runSettings(d, { action: "set", key: "integrations", value: JSON.stringify(value) });
      expect(r.ok, JSON.stringify(value)).toBe(false);
      expect(r.lines[0]).toMatch(/^refused: integrations/);
    }
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("only the owner sets it: a refusal from the owner check writes nothing", async () => {
    const { d, store } = await deps({ mayOwn: async () => "Only the owner changes this key; you are local:other." });
    const r = await runSettings(d, { action: "set", key: "integrations", value: '{"tacit":"agents-home"}' });
    expect(r).toEqual({ ok: false, lines: ["refused: integrations changes only by the owner: Only the owner changes this key; you are local:other."] });
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("the owner's set is stored with one audit row, free in either direction", async () => {
    const { d, store } = await deps({ mayOwn: async () => null, mayApproveMerge: async () => "no_role" });
    expect((await runSettings(d, { action: "set", key: "integrations", value: '{"tacit":"agents-home"}' })).ok).toBe(true);
    expect((await runSettings(d, { action: "reset", key: "integrations" })).ok).toBe(true);
    expect((await store.listSettingChanges(10)).map((c) => c.new_value)).toEqual([null, '{"tacit":"agents-home"}']);
  });
});

describe("integrations: the live tacit holder", () => {
  it("with no entry, factory.config.json decides: none stays none, a configured plugin stays that plugin", async () => {
    const off = await setup("none");
    await off.settings.refresh();
    expect(off.tacit.plugin()).toBe("none");
    expect(off.tacit.enabled).toBe(false);
    const on = await setup("fake");
    await on.settings.refresh();
    expect(on.tacit.plugin()).toBe("fake");
    expect(on.tacit.enabled).toBe(true);
  });

  it("an entry overrides plugins.tacit on the next refresh, and a reset goes back to the config's choice", async () => {
    const s = await setup("none");
    await s.set({ tacit: "fake" });
    expect(s.tacit.plugin()).toBe("none"); // not before the refresh
    await s.settings.refresh();
    expect(s.tacit.plugin()).toBe("fake");
    expect((await s.tacit.pending()).map((e) => e.title)).toEqual(["fake"]);
    await s.reset();
    await s.settings.refresh();
    expect(s.tacit.plugin()).toBe("none");
    expect(await s.tacit.pending()).toEqual([]);
  });

  it("keeps no copy of the entry: the settings' resolved value is the only one", async () => {
    const s = await setup("none");
    await s.set({ tacit: "fake" });
    await s.settings.refresh();
    expect(s.settings.values().integrations).toEqual({ tacit: "fake" });
    expect(Object.values(s.tacit).some((v) => typeof v === "object" && v !== null && "tacit" in v)).toBe(false);
  });

  it("a stored name the registry does not hold keeps the plugin in use", async () => {
    const s = await setup("fake");
    await s.store.setSettingOverride({ key: "integrations", project: "", value: '{"tacit":"gone"}', actor: "local:owner" });
    await s.settings.refresh();
    expect(s.tacit.plugin()).toBe("fake");
    expect(s.tacit.enabled).toBe(true);
  });

  it("no other interface's config is touched: only `tacit` is read from the entry", async () => {
    const s = await setup("none");
    await s.store.setSettingOverride({ key: "integrations", project: "", value: '{"secrets":"none","broker":"none"}', actor: "local:owner" });
    await s.settings.refresh();
    expect(s.tacit.plugin()).toBe("none");
    expect(s.settings.config()).toEqual(LiveSettings.fixed(config).config());
  });
});

describe("integrations: no restart", () => {
  it("the controller uses the new plugin from its next tick", async () => {
    const s = await setup("none");
    const controller = new ControllerRole({
      store: s.store, source: new FakeSource(), forge: new FakeForge(), auth: new FakeAuth(), clock: s.clock, config, log: silent, scanner: cleanScanner,
      settings: s.settings, tacit: s.tacit,
    });
    await controller.tickCommands();
    expect(s.tacit.enabled).toBe(false);
    await s.set({ tacit: "fake" });
    await controller.tickCommands();
    expect(s.tacit.plugin()).toBe("fake");
    expect(s.tacit.enabled).toBe(true);
  });

  it("the worker pool's learned rules read the new plugin from its next tick", async () => {
    const s = await setup("none");
    const cfg: FactoryConfig = { ...config, workers: 1 };
    const pool = new WorkerPool({
      id_prefix: "host:1", store: s.store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
      clock: s.clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings: s.settings,
      guidance: new LearnedRules(s.tacit),
    });
    const stop = new AbortController();
    const loops = pool.run(stop.signal);
    await s.set({ tacit: "fake" });
    // Each pool tick: the next sleep ends on the fake clock, then the loop gets real time to run.
    for (let i = 0; i < 200 && s.tacit.plugin() !== "fake"; i++) {
      s.clock.advance(cfg.tick_ms);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(s.tacit.plugin()).toBe("fake");
    expect(await new LearnedRules(s.tacit).read(silent)).toContain("rule from fake");
    stop.abort();
    await loops;
  });

  it("the plugin a worker gets is the holder itself, never a copy built at start", async () => {
    const s = await setup("none");
    const rules = new LearnedRules(s.tacit);
    expect(await rules.read(silent)).toBe("");
    await s.set({ tacit: "fake" });
    await s.settings.refresh();
    expect(await rules.read(silent)).toContain("rule from fake");
  });
});
