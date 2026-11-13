// Per-role tool grants as a runtime setting (design 08-settings, 2026-11-13): `tool_grants` changes with `factory
// settings set` and the Settings page. Granting a role a tool loosens, so it needs approve_merge and a refusal stores
// nothing; removing a grant needs none. The worker reads the grants in force, and a role without a grant cannot call
// the tool: the run passport the broker checks names only the granted tools (G2 unchanged). A tool call writes nothing new.

import { describe, expect, it } from "vitest";
import { PassportService, REVOCATIONS_TICK, secretKeyring } from "../src/identity/index.js";
import { grantsFor } from "../src/core/config.js";
import { LiveSettings, type SettingsBase, resolveSettings } from "../src/core/settings.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { PassportToolBroker } from "../src/impl/broker/passport-broker.js";
import { NOT_GRANTED, ToolGate } from "../src/impl/runner/tool-bridge.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { ToolBroker } from "../src/interfaces/tool-broker.js";
import { type SettingsDeps, parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { RunPassports } from "../src/worker/passports/run-passports.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PROJECT, config as fakeConfig } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";


const PREFLIGHT = "forge.preflight";
const base = (tool_grants?: unknown): SettingsBase => ({ file: tool_grants === undefined ? {} : { tool_grants }, layers: { defaults: {}, projects: {} } });

function deps(store: FactoryStore, b: SettingsBase, approve: string | null): SettingsDeps & { asked: number } {
  const d = {
    store, base: b, repo: { owner: "o", name: "r" }, actor: "local:dev", resolveProject: async () => PROJECT, asked: 0,
    mayApproveMerge: async () => (d.asked++, approve),
  };
  return d;
}

async function run(d: SettingsDeps, ...args: string[]) {
  const a = parseSettingsArgs(args);
  if ("error" in a) throw new Error(a.error);
  return runSettings(d, a);
}

describe("tool_grants: who may change it", () => {
  it("granting a role a tool without approve_merge is refused, and stores no override and no audit row", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, base(), "the requester cannot approve_merge");
    const r = await run(d, "set", "tool_grants", JSON.stringify({ triage: [PREFLIGHT] }));
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/loosening tool_grants .* needs approve_merge/);
    expect(d.asked).toBe(1);
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("with approve_merge the grant is stored and audited", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, base(), null);
    const r = await run(d, "set", "tool_grants", JSON.stringify({ triage: [PREFLIGHT] }));
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "tool_grants", project: "", value: JSON.stringify({ triage: [PREFLIGHT] }) })]);
    expect(await store.listSettingChanges(10)).toEqual([expect.objectContaining({ key: "tool_grants", actor: "local:dev", new_value: JSON.stringify({ triage: [PREFLIGHT] }) })]);
  });

  it("adding a role to a tool another role already has is a loosening too", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, base({ triage: [PREFLIGHT] }), "no");
    expect((await run(d, "set", "tool_grants", JSON.stringify({ triage: [PREFLIGHT], review: [PREFLIGHT] }))).ok).toBe(false);
    expect(await store.listSettingOverrides()).toEqual([]);
  });

  it("removing a grant needs no approval (tightening), and neither does keeping the same grants", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, base({ triage: [PREFLIGHT], review: [PREFLIGHT] }), "no");
    expect((await run(d, "set", "tool_grants", JSON.stringify({ triage: [PREFLIGHT] }))).ok).toBe(true);
    expect((await run(d, "set", "tool_grants", "{}")).ok).toBe(true);
    expect(d.asked).toBe(0);
    expect(await store.listSettingChanges(10)).toHaveLength(2);
  });

  it("resetting an override that removed grants loosens back to the file, so it needs approve_merge", async () => {
    const { store } = await newStore(new FakeClock());
    const tighten = deps(store, base({ triage: [PREFLIGHT] }), "no");
    expect((await run(tighten, "set", "tool_grants", "{}")).ok).toBe(true);
    const r = await run(tighten, "reset", "tool_grants");
    expect(r.ok).toBe(false);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "tool_grants", value: "{}" })]);
  });

  it("refuses a value that is not run kinds to tool names, with nothing stored", async () => {
    const { store } = await newStore(new FakeClock());
    const d = deps(store, base(), null);
    expect((await run(d, "set", "tool_grants", JSON.stringify({ deploy: [PREFLIGHT] }))).lines.join("\n")).toMatch(/not a run kind/);
    expect((await run(d, "set", "tool_grants", JSON.stringify({ triage: PREFLIGHT }))).ok).toBe(false);
    expect((await run(d, "set", "tool_grants", JSON.stringify({ triage: ["pack:widget"] }))).lines.join("\n")).toMatch(/pack:tool:<name>/);
    expect(await store.listSettingOverrides()).toEqual([]);
  });
});

describe("tool_grants: what the worker reads", () => {
  const config = (tool_grants?: FactoryConfig["tool_grants"]): FactoryConfig => ({ ...fakeConfig, ...(tool_grants ? { tool_grants } : {}) });

  it("a stored override replaces the file's grants in the live config; with none, the config's grants stay", async () => {
    const { store } = await newStore(new FakeClock());
    expect(LiveSettings.fixed(config({ triage: [PREFLIGHT] })).config().tool_grants).toEqual({ triage: [PREFLIGHT] });
    const live = new LiveSettings({ config: config({ triage: [PREFLIGHT] }), base: base({ triage: [PREFLIGHT] }), source: store });
    await store.setSettingOverride({ key: "tool_grants", project: "", value: JSON.stringify({ review: [PREFLIGHT] }), actor: "local:owner" });
    await live.refresh();
    expect(grantsFor(live.config().tool_grants, "review")).toEqual([PREFLIGHT]);
    expect(grantsFor(live.config().tool_grants, "triage")).toEqual([]);
  });

  it("a stored value that is not run kinds is ignored, and the file's grants stay in force", () => {
    const r = resolveSettings(base({ triage: [PREFLIGHT] }), [{ key: "tool_grants", project: "", value: JSON.stringify({ deploy: ["x"] }) }]);
    expect(r.values.tool_grants).toEqual({ triage: [PREFLIGHT] });
    expect(r.ignored.map((i) => i.key)).toEqual(["tool_grants"]);
  });
});

describe("tool_grants: a role without a grant cannot call the tool", () => {
  async function broker() {
    const db = new SqliteDriver(":memory:");
    await db.migrate();
    const ticks = new ManualTickGenerator();
    let n = 0;
    const KEY = { get: async () => ({ reveal: () => "k".repeat(40) }) };
    const identity = new PassportService({ db, keys: secretKeyring(KEY, { current: "K" }), providers: [], ticks, newId: () => `pp_${++n}` });
    await ticks.tick(REVOCATIONS_TICK, Date.parse("2026-11-13T09:00:00.000Z"));
    const calls: string[] = [];
    const inner: ToolBroker = {
      listTools: (grants) => [{ name: PREFLIGHT, description: "", input_schema: {}, read_only: true }].filter((t) => grants.includes(t.name)),
      allTools: () => [{ name: PREFLIGHT, description: "", input_schema: {}, read_only: true }],
      call: async (_ctx, name) => (calls.push(name), { ok: true, content: name }),
    };
    const runs = new RunPassports(identity);
    const guarded = new PassportToolBroker(inner, { checker: identity, passportOf: (r) => runs.passportOf(r) });
    const audits = async () => (await db.all("SELECT seq FROM authz_audit")).length;
    return { runs, guarded, calls, audits };
  }

  it("the broker refuses the call for a role the grants in force leave out, and passes it for the granted role", async () => {
    const { store } = await newStore(new FakeClock());
    await store.setSettingOverride({ key: "tool_grants", project: "", value: JSON.stringify({ triage: [PREFLIGHT] }), actor: "local:owner" });
    const live = new LiveSettings({ config: fakeConfig, base: base(), source: store });
    await live.refresh();
    const t = await broker();
    for (const [run, kind] of [["run_t", "triage"], ["run_r", "review"]] as const) {
      await t.runs.begin({ run, lease_token: 1, kind, item: "wi_1", project: "proj", branch: "factory/wi_1", grants: grantsFor(live.config().tool_grants, kind) });
    }
    const ctx = (run: string) => ({ run_id: run as RunId, work_item_id: "wi_1" as WorkItemId, lease_token: 1 });
    expect(await t.guarded.call(ctx("run_r"), PREFLIGHT, {})).toMatchObject({ ok: false, error_code: "passport_denied", message: `${PREFLIGHT}: outside_tools` });
    expect(await t.guarded.call(ctx("run_t"), PREFLIGHT, {})).toEqual({ ok: true, content: PREFLIGHT });
    expect(t.calls).toEqual([PREFLIGHT]);
    // The agent's side: the run's tool gate lists and calls only the role's grants.
    const signal = new AbortController().signal;
    const gate = new ToolGate({ broker: t.guarded, scanner: new PatternEgressScanner(async () => []) }, { ...ctx("run_r"), tool_grants: grantsFor(live.config().tool_grants, "review"), signal });
    expect(gate.list()).toEqual([]);
    expect(await gate.call(PREFLIGHT, {})).toMatchObject({ ok: false, error_code: NOT_GRANTED });
    expect(t.calls).toEqual([PREFLIGHT]);
  });

  it("a granted tool call adds no store write: last used is read from stored runs, not counted per call", async () => {
    const { store } = await newStore(new FakeClock());
    const writes: string[] = [];
    const counted = new Proxy(store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (typeof prop === "string" && !/^(get|list|read)/.test(prop)) writes.push(prop);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const live = new LiveSettings({ config: fakeConfig, base: base({ triage: [PREFLIGHT] }), source: counted });
    await live.refresh();
    const t = await broker();
    await t.runs.begin({ run: "run_t", lease_token: 1, kind: "triage", item: "wi_1", project: "proj", branch: "factory/wi_1", grants: grantsFor(live.config().tool_grants, "triage") });
    const before = await t.audits();
    const gate = new ToolGate({ broker: t.guarded, scanner: new PatternEgressScanner(async () => []) }, { run_id: "run_t" as RunId, work_item_id: "wi_1" as WorkItemId, lease_token: 1, tool_grants: grantsFor(live.config().tool_grants, "triage"), signal: new AbortController().signal });
    expect(await gate.call(PREFLIGHT, {})).toMatchObject({ ok: true });
    expect(writes).toEqual([]);
    // The passport check's own audit row, as before this change: one per call, nothing more.
    expect((await t.audits()) - before).toBe(1);
  });
});
