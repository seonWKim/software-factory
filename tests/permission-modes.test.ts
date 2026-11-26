// Permission modes, phase 1 (design 08-permissions, 2026-11-27): the owner-only `permission_mode` setting. Readable and
// settable through `factory settings set` and the settings API, owner only; ask_irreversible with nothing stored; a set
// toward `full` needs approve_merge, a set toward a tighter value does not; each set or reset writes one audit row.
// Nothing reads the mode yet: no test here checks a gate.

import { describe, expect, it } from "vitest";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { LiveSettings, OWNER_KEYS, PERMISSION_MODES, SETTABLE_DEFAULTS, SETTABLE_KEYS, type SettingsBase, baseFromConfig, parseSettable } from "../src/core/settings.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type SettingsDeps, runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps } from "../src/ui/pause-api.js";
import { type UiSettings, effectiveGlobal, newCsrfToken, readSettings, storeProjectResolver, writeSettings } from "../src/ui/settings-api.js";
import { PROJECT, config, silent } from "./helpers/fakes/config.js";
import { BACKENDS, newStore } from "./helpers/store.js";

const KEY = "permission_mode";
const base: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };
const REPO = { owner: "o", name: "r" };

function cliDeps(store: FactoryStore, over: Partial<SettingsDeps> = {}): SettingsDeps {
  return { store, base, repo: REPO, resolveProject: async () => PROJECT, actor: "local:owner", mayOwn: async () => null, mayApproveMerge: async () => null, ...over };
}

const set = (d: SettingsDeps, value: string) => runSettings(d, { action: "set", key: KEY, value: JSON.stringify(value) });
const reset = (d: SettingsDeps) => runSettings(d, { action: "reset", key: KEY });

describe("permission_mode: the key", () => {
  it("is settable and owner-only, defaults to ask_irreversible, and takes only its three values, tightest first", () => {
    expect(SETTABLE_KEYS).toContain(KEY);
    expect(OWNER_KEYS).toContain(KEY);
    expect(SETTABLE_DEFAULTS[KEY]).toBe("ask_irreversible");
    expect(PERMISSION_MODES).toEqual(["ask_all", "ask_irreversible", "full"]);
    for (const m of PERMISSION_MODES) expect(parseSettable(KEY, m)).toBe(m);
    for (const bad of ["ask", "FULL", "", 1, null]) expect(() => parseSettable(KEY, bad)).toThrow(/permission_mode must be/);
  });
});

describe.each(BACKENDS)("permission_mode through factory settings: $name", ({ make }) => {
  it("with nothing stored the mode is ask_irreversible, and settings load with no error", async () => {
    const { store } = await make();
    const live = new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent });
    await live.refresh();
    expect(live.values().permission_mode).toBe("ask_irreversible");
    const list = await runSettings(cliDeps(store), { action: "list" });
    expect(list.ok).toBe(true);
    expect(list.lines.join("\n")).toContain(KEY);
  });

  it("a non-owner set or reset is refused and writes nothing", async () => {
    const { store } = await make();
    const other = cliDeps(store, { actor: "local:other", mayOwn: async () => "Only the owner changes this key; you are local:other." });
    expect(await set(other, "ask_all")).toEqual({ ok: false, lines: ["refused: permission_mode changes only by the owner: Only the owner changes this key; you are local:other."] });
    await set(cliDeps(store), "ask_all");
    const before = await store.listSettingChanges(50);
    expect((await reset(other)).ok).toBe(false);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
    expect(await store.listSettingChanges(50)).toEqual(before);
  });

  it("a set toward full needs approve_merge; a set toward a tighter value does not", async () => {
    const { store } = await make();
    let asked = 0;
    const d = cliDeps(store, { mayApproveMerge: async () => (asked++, "no approve_merge") });
    // Tighter than the default: no approve_merge asked.
    expect((await set(d, "ask_all")).ok).toBe(true);
    expect(asked).toBe(0);
    // Back toward full from ask_all loosens it: asked and refused.
    const loose = await set(d, "full");
    expect(loose.ok).toBe(false);
    expect(loose.lines[0]).toMatch(/loosening permission_mode from "ask_all" to "full" needs approve_merge on the project: no approve_merge/);
    expect(asked).toBe(1);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
    // With approve_merge the same set is stored.
    const granted = cliDeps(store, { mayApproveMerge: async () => null });
    expect((await set(granted, "full")).ok).toBe(true);
    // From full, any set is tighter: no grant asked.
    asked = 0;
    expect((await set(d, "ask_irreversible")).ok).toBe(true);
    expect(asked).toBe(0);
  });

  it("each set and reset writes one settings history row with the actor and the time", async () => {
    const { store, clock } = await make();
    const d = cliDeps(store);
    await set(d, "ask_all");
    const at = clock.now().toISOString();
    expect((await store.listSettingChanges(50)).filter((c) => c.key === KEY)).toEqual([
      { seq: expect.any(Number), key: KEY, project: "", old_value: null, new_value: '"ask_all"', actor: "local:owner", at },
    ]);
    expect((await reset(d)).ok).toBe(true);
    const rows = (await store.listSettingChanges(50)).filter((c) => c.key === KEY);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ seq: expect.any(Number), key: KEY, project: "", old_value: '"ask_all"', new_value: null, actor: "local:owner", at: expect.any(String) });
  });
});

describe("permission_mode through the settings API", () => {
  async function setup(owner: string | null) {
    const clock = new FakeClock("2026-11-27T03:00:00.000Z");
    const { store } = await newStore(clock);
    await saveProjectLabel(store, PROJECT);
    if (owner) await store.claimOwner(owner);
    const settings: UiSettings = { base, repo: REPO, actor: "local:me", resolveProject: storeProjectResolver(store, REPO), csrfToken: newCsrfToken() };
    const d: PauseDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings,
      pauses: { principal: async () => "local:me", authorize: async () => ({ allow: true }), csrfToken: settings.csrfToken, log: silent },
    };
    return { store, d, settings };
  }

  it("reads ask_irreversible with nothing stored, and the owner's set is read back", async () => {
    const { store, d, settings } = await setup("local:me");
    expect(await effectiveGlobal(d, KEY)).toEqual({ value: "ask_irreversible", source: "default" });
    expect(JSON.stringify((await readSettings(d, settings)).keys)).toContain(KEY);
    expect((await writeSettings(d, settings, { action: "set", key: KEY, value: '"ask_all"' })).status).toBe(200);
    expect((await effectiveGlobal(d, KEY)).value).toBe("ask_all");
    expect((await store.listSettingChanges(50)).filter((c) => c.key === KEY)).toEqual([expect.objectContaining({ actor: "local:me", new_value: '"ask_all"' })]);
  });

  it("refuses a set and a reset from someone who is not the owner", async () => {
    const { store, d, settings } = await setup("local:owner");
    await store.setSettingOverride({ key: KEY, project: "", value: '"ask_all"', actor: "local:owner" });
    for (const body of [{ action: "set", key: KEY, value: '"full"' }, { action: "reset", key: KEY }]) {
      const r = await writeSettings(d, settings, body);
      expect(r.status).toBe(422);
      expect((r.value as { error: string }).error).toMatch(/permission_mode changes only by the owner/);
    }
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
  });
});
