import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alarmConfig, loadConfig } from "../src/compose.js";
import { ConfigKeyError, unknownConfigKeys } from "../src/config-keys.js";
import {
  BUILT_IN_SETTINGS,
  type LearnedSettingsSource,
  PROJECT_SETTING_KEYS,
  PR_ONLY_DESCRIPTIONS,
  PR_ONLY_KEYS,
  type PrOnlyKey,
  SETTABLE_DEFAULTS,
  SETTABLE_KEYS,
  SETTING_APPLIES,
  SETTING_DESCRIPTIONS,
  type SettableKey,
  type ProjectSettingKey,
  type ProjectSettings,
  type SettingsLayers,
  describeSettings,
  isProjectSettableKey,
  keyRefusal,
  parseSettable,
  resolveSettings,
  settingsFor,
  settingsLayers,
} from "../src/core/settings.js";
import { settingsChecks } from "../src/setup.js";

// Design 2026-11-01, "Settings resolve in layers": learned → project → defaults → built-in, and a project
// may only tighten a gate.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const ID = "seonWKim/software-factory";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts and secret file. */
function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-settings-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

async function load(config: Record<string, unknown>) {
  return loadConfig(root(config));
}

async function loadError(config: Record<string, unknown>): Promise<Error> {
  const err = await load(config).then(
    () => null,
    (e: Error) => e,
  );
  if (!err) throw new Error("loadConfig succeeded");
  return err;
}

/** REAL without the per-project keys at top level, so a test can place them where it wants. */
function bare(): Record<string, unknown> {
  const c = { ...REAL };
  for (const k of PROJECT_SETTING_KEYS) delete c[k];
  return c;
}

/** REAL with one project block for the configured repo. */
function withProject(block: Record<string, unknown>, base: Record<string, unknown> = REAL): Record<string, unknown> {
  return { ...base, projects: { [ID]: block } };
}

const GLOBAL_FLOORS = REAL.floors as { prefix: string; tier: number }[];

class FakeLearned implements LearnedSettingsSource {
  constructor(private readonly values: Partial<Record<string, Partial<ProjectSettings>>>) {}
  get<K extends ProjectSettingKey>(project: string, key: K): ProjectSettings[K] | undefined {
    return this.values[project]?.[key] as ProjectSettings[K] | undefined;
  }
}

describe("settings: config shape", () => {
  it("top-level setting keys still load as the global values", async () => {
    const { config } = await load(REAL);
    const s = settingsFor(ID, config.settings);
    expect(s.max_attempts).toEqual({ value: 3, layer: "defaults" });
    expect(s.max_diff_lines).toEqual({ value: 5000, layer: "defaults" });
    expect(s.floors.value).toEqual(GLOBAL_FLOORS);
  });

  it("a `defaults` object and a `projects` object keyed by project ID load", async () => {
    const { config } = await load({
      ...bare(),
      defaults: { max_attempts: 4, floors: GLOBAL_FLOORS },
      projects: { [ID]: { max_attempts: 2 } },
    });
    expect(config.settings.defaults).toMatchObject({ max_attempts: 4 });
    expect(config.settings.projects[ID]).toEqual({ max_attempts: 2 });
  });

  for (const key of PROJECT_SETTING_KEYS) {
    it(`setting ${key} both at top level and in defaults fails at startup`, async () => {
      const err = await loadError({ ...REAL, [key]: (REAL[key] ?? (key === "budgets" ? {} : 3)), defaults: { [key]: REAL[key] ?? (key === "budgets" ? {} : 3) } });
      expect(err.message).toContain(`"${key}" is set both at top level and in defaults`);
    });
  }

  it("a project key that does not match the configured repo's ID fails at startup", async () => {
    const err = await loadError({ ...REAL, projects: { "someone/else": { max_attempts: 1 } } });
    expect(err.message).toContain('"someone/else"');
    expect(err.message).toContain(`"${ID}"`);
  });

  it("the github.com/owner/name form is not the configured repo's ID", async () => {
    const err = await loadError({ ...REAL, projects: { [`github.com/${ID}`]: { max_attempts: 1 } } });
    expect(err.message).toMatch(/does not match the configured repo's ID/);
  });

  it("no change to factory.config.json: it sets neither defaults nor projects", () => {
    expect(REAL.defaults).toBeUndefined();
    expect(REAL.projects).toBeUndefined();
  });
});

describe("settings: layer order", () => {
  const layers = (defaults: Partial<ProjectSettings>, project: Partial<ProjectSettings> = {}): SettingsLayers => ({
    defaults,
    projects: { [ID]: project },
  });

  it("built-in default when nothing is set", () => {
    const s = settingsFor(ID, { defaults: {}, projects: {} });
    for (const k of PROJECT_SETTING_KEYS) expect(s[k]).toEqual({ value: BUILT_IN_SETTINGS[k], layer: "built-in" });
  });

  it("defaults over built-in", () => {
    expect(settingsFor(ID, layers({ max_attempts: 5 })).max_attempts).toEqual({ value: 5, layer: "defaults" });
  });

  it("project override over defaults", () => {
    expect(settingsFor(ID, layers({ max_attempts: 5 }, { max_attempts: 2 })).max_attempts).toEqual({ value: 2, layer: "project" });
  });

  it("another project gets the defaults, not this project's override", () => {
    expect(settingsFor("x/y", layers({ max_attempts: 5 }, { max_attempts: 2 })).max_attempts).toEqual({ value: 5, layer: "defaults" });
  });

  it("learned value over project override, from a pluggable source", () => {
    const learned = new FakeLearned({ [ID]: { max_attempts: 1 } });
    const s = settingsFor(ID, layers({ max_attempts: 5 }, { max_attempts: 2 }), learned);
    expect(s.max_attempts).toEqual({ value: 1, layer: "learned" });
    expect(s.max_diff_lines.layer).toBe("built-in");
  });

  it("a learned value that would loosen a gate past the global value is ignored", () => {
    const learned = new FakeLearned({ [ID]: { max_attempts: 9, floors: [] } });
    const s = settingsFor(ID, layers({ max_attempts: 5, floors: [{ prefix: "a/", tier: 3 }] }, { max_attempts: 2 }), learned);
    expect(s.max_attempts).toEqual({ value: 2, layer: "project" });
    expect(s.floors.layer).toBe("defaults");
  });

  it("settingsFor returns every per-project key with its value and layer", async () => {
    const { config } = await load(withProject({ max_diff_files: 10 }));
    const s = settingsFor(ID, config.settings);
    expect(Object.keys(s).sort()).toEqual([...PROJECT_SETTING_KEYS].sort());
    expect(s.max_diff_files).toEqual({ value: 10, layer: "project" });
    expect(s.max_attempts.layer).toBe("defaults");
    expect(s.budgets).toEqual({ value: {}, layer: "built-in" });
  });

  it("the per-project keys are exactly these; repo commands are not among them", () => {
    expect([...PROJECT_SETTING_KEYS].sort()).toEqual(["budgets", "floors", "max_attempts", "max_diff_files", "max_diff_lines"]);
  });
});

describe("settings: a project may only tighten a gate", () => {
  for (const key of ["max_attempts", "max_diff_lines", "max_diff_files"] as const) {
    const global = REAL[key] as number;
    it(`${key}: above the global value fails at startup`, async () => {
      const err = await loadError(withProject({ [key]: global + 1 }));
      expect(err.message).toContain(`projects["${ID}"].${key}`);
      expect(err.message).toContain(`above the global value ${global}`);
    });
    it(`${key}: equal or lower passes`, async () => {
      await expect(load(withProject({ [key]: global }))).resolves.toBeDefined();
      const { config } = await load(withProject({ [key]: global - 1 }));
      expect(settingsFor(ID, config.settings)[key]).toEqual({ value: global - 1, layer: "project" });
    });
  }

  it("a project tighter than a built-in default passes; looser fails", async () => {
    await expect(load(withProject({ max_attempts: 3 }, bare()))).resolves.toBeDefined();
    const err = await loadError(withProject({ max_attempts: 4 }, { ...bare(), floors: GLOBAL_FLOORS }));
    expect(err.message).toContain("above the global value 3");
  });

  describe("budgets, per tier", () => {
    const base = { ...REAL, budgets: { 2: 1000, 3: 5000 } };
    it("a tier above the global value fails at startup", async () => {
      const err = await loadError(withProject({ budgets: { 2: 1001, 3: 5000 } }, base));
      expect(err.message).toContain(`projects["${ID}"].budgets`);
      expect(err.message).toContain("tier 2 to 1001, above the global value 1000");
    });
    it("equal or lower passes", async () => {
      const { config } = await load(withProject({ budgets: { 2: 1000, 3: 10 } }, base));
      expect(settingsFor(ID, config.settings).budgets).toEqual({ value: { 2: 1000, 3: 10 }, layer: "project" });
    });
    it("leaving out a tier the global value limits fails: no limit is looser", async () => {
      const err = await loadError(withProject({ budgets: { 2: 1000 } }, base));
      expect(err.message).toContain("removes the global budget for tier 3");
    });
    it("a tier with no global limit may be limited", async () => {
      const { config } = await load(withProject({ budgets: { 1: 50 } }));
      expect(settingsFor(ID, config.settings).budgets.value).toEqual({ 1: 50 });
    });
  });

  describe("floors", () => {
    it("a project may add entries and raise a tier", async () => {
      const floors = [...GLOBAL_FLOORS.map((f) => (f.prefix === "prompts/" ? { ...f, tier: 4 } : f)), { prefix: "docs/", tier: 2 }];
      const { config } = await load(withProject({ floors }));
      expect(settingsFor(ID, config.settings).floors).toEqual({ value: floors, layer: "project" });
    });
    it("removing a global entry fails at startup", async () => {
      const err = await loadError(withProject({ floors: GLOBAL_FLOORS.filter((f) => f.prefix !== "src/core/") }));
      expect(err.message).toContain('removes the global floor "src/core/"');
    });
    it("lowering a tier fails at startup", async () => {
      const floors = GLOBAL_FLOORS.map((f) => (f.prefix === "src/impl/github/github-tool-broker.ts" ? { ...f, tier: 2 } : f));
      const err = await loadError(withProject({ floors }));
      expect(err.message).toContain('lowers the floor "src/impl/github/github-tool-broker.ts" to tier 2, below the global tier 4');
    });
    it("a bad project floor tier fails like a top-level one", async () => {
      const err = await loadError(withProject({ floors: [...GLOBAL_FLOORS, { prefix: "x/", tier: 9 }] }));
      expect(err.message).toBe("tiers must be integers 1–5");
    });
  });
});

describe("settings: unknown keys inside a project", () => {
  const rejected: [string, unknown][] = [
    ["auto_merge_max_tier", 0],
    ["dials", { spec_gate_min_tier: 1, auto_merge_max_tier: 0 }],
    ["plugins", { secrets: "env-file" }],
    ["repo", { test_command: ["true"] }],
    ["budget_min_sample", 1],
    ["secrets", "env-file"],
    ["egress", "pattern"],
    ["broker", "github"],
    ["test_command", ["true"]],
  ];
  for (const [key, value] of rejected) {
    it(`${key} is rejected as an unknown key`, async () => {
      const err = await loadError(withProject({ [key]: value }));
      expect(err).toBeInstanceOf(ConfigKeyError);
      expect(err.message).toContain(`unknown config key "${key}" at projects["${ID}"].${key}`);
      expect(err.message).toContain(`valid project "${ID}" keys: ${PROJECT_SETTING_KEYS.join(", ")}`);
    });
  }

  it("a close typo gets a suggestion, in the top-level error's format", async () => {
    const err = await loadError(withProject({ max_atempts: 2 }));
    expect(err.message).toBe(
      `unknown config key "max_atempts" at projects["${ID}"].max_atempts; valid project "${ID}" keys: ` +
        `${PROJECT_SETTING_KEYS.join(", ")}; did you mean "max_attempts"?`,
    );
  });

  it("an unknown key inside a project floors entry names the path", async () => {
    const err = await loadError(withProject({ floors: [...GLOBAL_FLOORS, { prefix: "x/", tiar: 3 }] }));
    expect(err.message).toContain(`projects["${ID}"].floors[${GLOBAL_FLOORS.length}].tiar`);
  });

  it("an unknown key inside defaults fails too", async () => {
    const err = await loadError({ ...REAL, defaults: { max_loops: 3 } });
    expect(err.message).toContain('unknown config key "max_loops" at defaults.max_loops');
  });
});

describe("settings: doctor and status page", () => {
  it("doctor lists each per-project setting's effective value and source layer for each project", async () => {
    const loaded = await load(withProject({ max_attempts: 2 }));
    const lines = settingsChecks(loaded).map((c) => c.msg);
    expect(settingsChecks(loaded).every((c) => c.ok)).toBe(true);
    expect(lines).toHaveLength(PROJECT_SETTING_KEYS.length);
    expect(lines).toContain(`setting for ${ID}: max_attempts = 2 (project)`);
    expect(lines).toContain(`setting for ${ID}: max_diff_lines = 5000 (defaults)`);
    expect(lines).toContain(`setting for ${ID}: budgets = no limits (built-in)`);
    expect(lines.find((l) => l.includes("floors ="))).toContain("src/impl/github/github-tool-broker.ts≥4");
  });

  it("describeSettings has one line per key with the layer", () => {
    const lines = describeSettings(settingsFor(ID, { defaults: { budgets: { 2: 10 } }, projects: {} }));
    expect(lines).toContain("budgets = tier 2: 10 (defaults)");
    expect(lines).toContain("floors = none (built-in)");
  });
});

describe("settings: SET_UP.md example", () => {
  it("the example config has no unknown keys and passes the layer checks", () => {
    const text = readFileSync(join(REPO_ROOT, "SET_UP.md"), "utf8");
    const section = text.slice(text.indexOf("### Per-project settings"));
    const json = section.match(/```json\n([\s\S]*?)```/)![1]!;
    const example = JSON.parse(json) as Record<string, unknown>;
    expect(unknownConfigKeys(example)).toEqual([]);
    const s = settingsFor("acme/shop", settingsLayers(example, "acme/shop"));
    expect(s.max_diff_lines).toEqual({ value: 800, layer: "project" });
    expect(s.max_attempts).toEqual({ value: 3, layer: "defaults" });
  });
});

describe("settings: pure layer checks", () => {
  it("settingsLayers rejects a non-object projects or defaults", () => {
    expect(() => settingsLayers({ projects: [] }, ID)).toThrow(/projects must be an object/);
    expect(() => settingsLayers({ defaults: 1 }, ID)).toThrow(/defaults must be an object/);
  });
});

// Every read of a per-project key goes through src/core/settings.ts. Anything else that reads one from
// the config objects (FactoryConfig, the parsed file) would bypass the project layer and the learned layer.
describe("settings: boundary", () => {
  const SRC = join(REPO_ROOT, "src");
  const ALLOWED = new Set(["core/settings.ts"]);
  const KEYS = PROJECT_SETTING_KEYS.join("|");
  const direct = new RegExp(`\\b(?:config|cfg|file|raw|loaded\\.config|loaded\\.file)\\??\\.(?:${KEYS})\\b`);
  const destructure = new RegExp(`\\{[^}]*\\b(?:${KEYS})\\b[^}]*\\}\\s*=\\s*[\\w.]*(?:config|file)\\b`);
  const indexed = new RegExp(`\\b(?:config|file|raw)\\[["'](?:${KEYS})["']\\]`);

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  }

  /** Every line outside the settings module that reads a per-project key from a config object. */
  function violations(sources: { name: string; text: string }[]): string[] {
    const out: string[] = [];
    for (const { name, text } of sources) {
      if (ALLOWED.has(name)) continue;
      text.split("\n").forEach((line, i) => {
        if (direct.test(line) || destructure.test(line) || indexed.test(line)) out.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    return out;
  }

  it("no code outside the settings module reads a per-project key from top-level config", () => {
    const sources = files(SRC).map((f) => ({ name: relative(SRC, f), text: readFileSync(f, "utf8") }));
    expect(violations(sources)).toEqual([]);
  });

  it("the check catches each form of a direct read", () => {
    const bad = [
      "const n = this.d.config.max_attempts;",
      "floorTier(paths, config.floors)",
      "const { max_diff_lines, max_diff_files } = this.d.config;",
      "tierBudget(loaded.config.budgets, 2)",
      "if (file.max_attempts > 3) x();",
      'const f = raw["floors"];',
    ];
    expect(violations(bad.map((text, i) => ({ name: `x${i}.ts`, text })))).toHaveLength(bad.length);
    expect(violations([{ name: "core/settings.ts", text: bad[0]! }])).toEqual([]);
  });
});

describe("settings: alarm keys (design 05-alarms)", () => {
  const KEYS = ["alarm_repeat_count", "alarm_window_minutes", "alarm_restart_count"] as const;

  it("are settable, default to 3, 60 and 5, and take a positive integer override", () => {
    for (const k of KEYS) expect(SETTABLE_KEYS).toContain(k);
    expect(KEYS.map((k) => SETTABLE_DEFAULTS[k])).toEqual([3, 60, 5]);
    const base = { file: {}, layers: { defaults: {}, projects: {} } };
    expect(KEYS.map((k) => resolveSettings(base, []).values[k])).toEqual([3, 60, 5]);
    const row = (key: string, value: string) => ({ key, project: "", value });
    const r = resolveSettings(base, [row("alarm_repeat_count", "4"), row("alarm_window_minutes", "0")]);
    expect(r.values).toMatchObject({ alarm_repeat_count: 4, alarm_window_minutes: 60 });
    expect(r.ignored.map((i) => i.key)).toEqual(["alarm_window_minutes"]);
  });

  it("the file values are checked at load", () => {
    expect(alarmConfig({})).toEqual({ alarm_repeat_count: 3, alarm_window_minutes: 60, alarm_restart_count: 5 });
    expect(alarmConfig({ alarm_restart_count: 8 }).alarm_restart_count).toBe(8);
    expect(() => alarmConfig({ alarm_repeat_count: 0 })).toThrow("alarm_repeat_count must be a positive integer");
  });
});

describe("settings: descriptions", () => {
  const all: [string, string | undefined][] = [
    ...SETTABLE_KEYS.map((k) => [k, SETTING_DESCRIPTIONS[k]] as [string, string | undefined]),
    ...PR_ONLY_KEYS.map((k) => [k, PR_ONLY_DESCRIPTIONS[k]] as [string, string | undefined]),
  ];

  it("every settable and PR-only key has one plain sentence of at most 100 characters", () => {
    for (const [k, d] of all) {
      expect(typeof d, k).toBe("string");
      expect(d!.trim(), k).not.toBe("");
      expect(d!.length, k).toBeLessThanOrEqual(100);
      expect(d, k).toMatch(/^[A-Z][^\n]*\.$/);
    }
  });

  it("does not repeat the applies-at text", () => {
    for (const k of SETTABLE_KEYS) expect(SETTING_DESCRIPTIONS[k]).not.toContain(SETTING_APPLIES[k]);
  });

  it("the records are typed so a missing key fails the type check", () => {
    const { max_loops: _l, ...settable } = SETTING_DESCRIPTIONS;
    // @ts-expect-error max_loops is missing
    const s: Record<SettableKey, string> = settable;
    const { plugins: _p, ...prOnly } = PR_ONLY_DESCRIPTIONS;
    // @ts-expect-error plugins is missing
    const p: Record<PrOnlyKey, string> = prOnly;
    expect(Object.keys(s)).not.toContain("max_loops");
    expect(Object.keys(p)).not.toContain("plugins");
  });
});

describe("settings: standing_approvals.threshold", () => {
  const KEY = "standing_approvals.threshold";
  const base = { file: {}, layers: { defaults: {}, projects: {} } };
  const row = (value: string) => ({ key: KEY, project: "", value });

  it("is a global settable key, 10 by default, read live through resolveSettings", () => {
    expect(SETTABLE_KEYS).toContain(KEY);
    expect(isProjectSettableKey(KEY)).toBe(false);
    expect(keyRefusal(KEY)).toBeNull();
    expect(resolveSettings(base, []).values[KEY]).toBe(10);
    expect(resolveSettings(base, [row("4")]).values[KEY]).toBe(4);
  });

  it.each([0, -1, 2.5, "10", true, null, {}])("refuses %j on set and when stored overrides load", (bad) => {
    expect(() => parseSettable(KEY, bad)).toThrow(`${KEY} must be a positive integer`);
    const r = resolveSettings(base, [row(JSON.stringify(bad))]);
    expect(r.values[KEY]).toBe(10);
    expect(r.ignored).toContainEqual(expect.objectContaining({ key: KEY }));
  });

  it("is not a config file key: the file cannot hold a second value for it", () => {
    expect(unknownConfigKeys({ standing_approvals: { threshold: 10 } })).toHaveLength(1);
  });
});
