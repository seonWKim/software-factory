// The coordinator's daily spend limit (design 06-spend): spend.coordinator_daily_usd, decimal dollars, default 5.
// It is in the settings catalog as a runtime, global usd setting owned by the controller; unset, it reads 5; it
// takes a positive amount and refuses null, zero and negative amounts. Nothing reads it in a cycle yet.

import { describe, expect, it } from "vitest";
import { SETTABLE_DEFAULTS, isSettableKey, parseSettable, resolveSettings } from "../src/core/settings.js";
import { loadSettingCatalog } from "../src/runtime/settings/catalog.js";

const KEY = "spend.coordinator_daily_usd";

describe(KEY, () => {
  it("is in the settings catalog: usd, owner controller, changed at runtime, global, default 5", async () => {
    expect((await loadSettingCatalog()).get(KEY)).toMatchObject({ type: "usd", owner: "controller", changed_by: "runtime", scope: "global", default: 5 });
    expect(isSettableKey(KEY)).toBe(true);
    expect(SETTABLE_DEFAULTS[KEY]).toBe(5);
  });

  it("reads 5 when unset, and an override's amount when set", () => {
    const empty = { file: {}, layers: { defaults: {}, projects: {} } };
    expect(resolveSettings(empty, []).values[KEY]).toBe(5);
    expect(resolveSettings(empty, [{ key: KEY, project: "", value: "7.5" }]).values[KEY]).toBe(7.5);
  });

  it("accepts a positive amount and refuses null, zero and negative amounts", () => {
    expect(parseSettable(KEY, 12.5)).toBe(12.5);
    expect(parseSettable(KEY, 5)).toBe(5);
    for (const bad of [null, 0, -1, "5", true]) expect(() => parseSettable(KEY, bad), String(bad)).toThrow(/positive dollar amount/);
  });
});
