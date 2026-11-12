import { describe, expect, it } from "vitest";
import {
  LiveSettings,
  SETTABLE_DEFAULTS,
  SETTABLE_KEYS,
  type SettingsBase,
  effectiveSetting,
  keyRefusal,
  parseSettable,
  resolveSettings,
  settingValues,
} from "../src/core/settings.js";
import { parseModelBy } from "../src/core/model-choice.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { config, recordingLog } from "./helpers/fakes.js";

const row = (key: string, value: unknown, project = "") => ({ key, project, value: JSON.stringify(value) });

/** The file sets max_loops and workers, defaults.max_attempts, and a project block; nothing else. */
const base: SettingsBase = {
  file: { max_loops: 4, workers: 5, heartbeat_ms: 60_000, lease_ms: 300_000 },
  layers: { defaults: { max_attempts: 4 }, projects: { [PROJECT_KEY]: { max_diff_files: 10 } } },
};

describe("effective value: override, else file, else built-in default", () => {
  it("each of the three sources", () => {
    const r = resolveSettings(base, [row("max_loops", 7)]);
    expect(effectiveSetting(r, "max_loops")).toMatchObject({ value: 7, source: "override" });
    expect(effectiveSetting(r, "max_attempts")).toMatchObject({ value: 4, source: "file" });
    expect(effectiveSetting(r, "workers")).toMatchObject({ value: 5, source: "file" });
    expect(effectiveSetting(r, "tick_ms")).toMatchObject({ value: 2_000, source: "default" });
    expect(effectiveSetting(r, "model_by")).toMatchObject({ value: parseModelBy(undefined), source: "default" });
    expect(r.ignored).toEqual([]);
  });

  it("every settable key has a default that passes its own check", () => {
    for (const k of SETTABLE_KEYS) expect(() => parseSettable(k, SETTABLE_DEFAULTS[k])).not.toThrow();
    expect(new Set(SETTABLE_KEYS).size).toBe(SETTABLE_KEYS.length);
    expect(parseSettable("phases_auto_approve", true)).toBe(true);
    expect(() => parseSettable("phases_auto_approve", "yes")).toThrow("phases_auto_approve must be true or false");
  });

  it("a global override of a per-project key sits above the file's global value; a project override above its block", () => {
    const r = resolveSettings(base, [row("max_attempts", 2), row("max_diff_files", 5, PROJECT_KEY), row("max_diff_lines", 100, PROJECT_KEY)]);
    expect(effectiveSetting(r, "max_attempts")).toMatchObject({ value: 2, source: "override" });
    expect(effectiveSetting(r, "max_diff_files", PROJECT_KEY)).toMatchObject({ value: 5, source: "override" });
    expect(effectiveSetting(r, "max_diff_lines", PROJECT_KEY)).toMatchObject({ value: 100, source: "override" });
    expect(settingValues(PROJECT_KEY, r.layers)).toMatchObject({ max_attempts: 2, max_diff_files: 5, max_diff_lines: 100 });
    // Another project only sees the global values.
    expect(settingValues("github:github.com:other", r.layers)).toMatchObject({ max_attempts: 2, max_diff_files: 40 });
  });

  it("workers is capped at the file's value on read when the file has no max_workers", () => {
    const r = resolveSettings(base, [row("workers", 9)]);
    expect(r.values.workers).toBe(5);
    expect(r.workers_cap).toBe(5);
  });

  it("with max_workers, a workers override goes above the file's workers up to max_workers", () => {
    const wide = { ...base, max_workers: 8 };
    expect(resolveSettings(wide, [row("workers", 7)]).values.workers).toBe(7);
    const r = resolveSettings(wide, [row("workers", 9)]);
    expect(r.values.workers).toBe(8);
    expect(r.workers_cap).toBe(8);
    expect(resolveSettings(wide, []).values.workers).toBe(5);
  });
});

describe("a stored override that fails a check is ignored, and its key keeps the file value", () => {
  it("bad JSON, a bad value, an unknown key, a PR-only key, a per-project value of a global key", () => {
    const r = resolveSettings(base, [
      { key: "tick_ms", project: "", value: "{not json" },
      row("max_loops", 0),
      row("budgets", { 1: 5 }),
      row("plugins", {}),
      row("tick_ms", 10, PROJECT_KEY),
    ]);
    expect(r.values.max_loops).toBe(4);
    expect(r.values.tick_ms).toBe(2_000);
    expect(r.ignored.map((i) => i.reason)).toEqual([
      "tick_ms: the stored value is not JSON",
      "max_loops must be a positive integer",
      expect.stringContaining('"budgets" is not settable'),
      expect.stringContaining('"plugins" changes by PR only'),
      expect.stringContaining("tick_ms has no per-project value"),
    ]);
  });

  it("heartbeat × 2 ≥ lease drops the overrides involved", () => {
    const r = resolveSettings(base, [row("lease_ms", 100_000)]);
    expect(r.values.lease_ms).toBe(300_000);
    expect(r.ignored).toEqual([expect.objectContaining({ key: "lease_ms", reason: "heartbeat_ms must be well under lease_ms" })]);
    const ok = resolveSettings(base, [row("lease_ms", 100_000), row("heartbeat_ms", 30_000)]);
    expect(ok.values).toMatchObject({ lease_ms: 100_000, heartbeat_ms: 30_000 });
  });

  it("retry_base_ms above retry_max_ms is dropped", () => {
    const r = resolveSettings(base, [row("retry_base_ms", 5_000_000)]);
    expect(r.values.retry_base_ms).toBe(60_000);
    expect(r.ignored[0]!.reason).toBe("retry_base_ms must not exceed retry_max_ms");
  });

  it("a project override looser than the global value, and a global override below a project's file value", () => {
    const r = resolveSettings(base, [row("max_attempts", 9, PROJECT_KEY), row("max_diff_files", 8)], () => "o/r");
    expect(settingValues(PROJECT_KEY, r.layers)).toMatchObject({ max_attempts: 4, max_diff_files: 10 });
    expect(r.values.max_diff_files).toBe(40);
    expect(r.ignored.map((i) => i.reason)).toEqual([
      'max_diff_files 8 would leave projects["o/r"].max_diff_files (10) looser than the global value; a project may only tighten a gate',
      'projects["o/r"].max_attempts is 9, above the global value 4; a project may only tighten a gate',
    ]);
  });

  it("LiveSettings logs an ignored override once, keeps the file value and keeps running", async () => {
    const { store } = await newStore();
    const log = recordingLog();
    const live = new LiveSettings({ config, base: { file: { max_loops: 3 }, layers: config.settings }, source: store, log });
    await store.setSettingOverride({ key: "max_loops", project: "", value: '"three"', actor: "local:t" });
    await live.refresh();
    await live.refresh();
    expect(live.config().max_loops).toBe(3);
    expect(log.lines.filter((l) => l.msg.startsWith("settings override ignored"))).toEqual([
      { level: "warn", msg: "settings override ignored; the file value stays in use", fields: { key: "max_loops", project: null, reason: "max_loops must be a positive integer" } },
    ]);
  });

  it("LiveSettings keeps the values in use when the store read fails", async () => {
    const log = recordingLog();
    let fail = false;
    const source = {
      listSettingOverrides: async () => {
        if (fail) throw new Error("db down");
        return [{ ...row("max_loops", 6), set_by: "local:t", set_at: "2026-01-01T00:00:00.000Z" as never }];
      },
    };
    const live = new LiveSettings({ config, base: { file: { max_loops: 3 }, layers: config.settings }, source, log });
    await live.refresh();
    fail = true;
    await live.refresh();
    expect(live.config().max_loops).toBe(6);
    expect(log.lines.some((l) => l.msg.includes("could not be read"))).toBe(true);
  });
});

describe("key refusals", () => {
  it("PR-only keys and keys outside the allow-list", () => {
    for (const k of ["plugins", "repo", "store", "floors", "dials", "auth", "secrets", "egress", "broker"]) {
      expect(keyRefusal(k)).toContain("changes by PR only");
    }
    for (const k of ["budgets", "inbox_retention_days", "stats", "ui", "branch_prefix", "nope"]) {
      expect(keyRefusal(k)).toContain("is not settable");
    }
    for (const k of SETTABLE_KEYS) expect(keyRefusal(k)).toBeNull();
  });
});
