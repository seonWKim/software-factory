import { describe, expect, it } from "vitest";
import {
  APPROVE_MERGE_KEYS,
  GATE_SETTABLE_KEYS,
  PROJECT_SETTABLE_KEYS,
  PR_ONLY_KEYS,
  SETTABLE_DEFAULTS,
  SETTABLE_KEYS,
  keyRefusal,
  loosening,
} from "../src/core/settings.js";
import { loadSettingCatalog } from "../src/runtime/index.js";
import { loosens } from "../src/shared/setting.js";

// RFC 0015 M10: the settings catalog (one `*.setting.ts` per key) and the legacy key lists in src/core/settings.ts,
// which the running resolver still types its values by, say the same thing until that file moves into the runtime.

const catalog = await loadSettingCatalog();
const keys = (pred: (s: ReturnType<typeof catalog.all>[number]) => boolean) => catalog.all().filter(pred).map((s) => s.key).sort();

describe("settings catalog", () => {
  it("holds every settable key (runtime) and every PR-only key (review), and nothing else", () => {
    expect(keys((s) => s.changed_by === "runtime")).toEqual([...SETTABLE_KEYS].sort());
    expect(keys((s) => s.changed_by === "review")).toEqual([...PR_ONLY_KEYS].sort());
    for (const k of SETTABLE_KEYS) expect(keyRefusal(k), k).toBeNull();
  });

  it("says what the resolver does: defaults, per-project keys, keys that need approve_merge", () => {
    for (const k of SETTABLE_KEYS) expect(catalog.get(k)!.default, k).toEqual(SETTABLE_DEFAULTS[k]);
    expect(keys((s) => s.changed_by === "runtime" && s.scope === "project")).toEqual([...PROJECT_SETTABLE_KEYS].sort());
    expect(keys((s) => s.change_needs === "approve_merge")).toEqual([...APPROVE_MERGE_KEYS].sort());
  });

  it("orders each per-project gate as the resolver's tighten-only check does", () => {
    for (const k of GATE_SETTABLE_KEYS) {
      const s = catalog.get(k)!;
      for (const v of [2, 3, 4]) expect(loosens(s, v, 3) === null, `${k} ${v}`).toBe(loosening(k, v, 3) === null);
    }
  });

  it("describes every key in one plain sentence of at most 100 characters, apart from when it applies", () => {
    for (const s of catalog.all()) {
      expect(s.description, s.key).toMatch(/^[A-Z][^\n]*\.$/);
      expect(s.description.length, s.key).toBeLessThanOrEqual(100);
      if (s.applies !== null) expect(s.description, s.key).not.toContain(s.applies);
    }
  });
});
