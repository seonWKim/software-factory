import type { Budgets } from "./budget.js";
import { DIFF_LIMIT_DEFAULTS } from "./diff-gate.js";
import type { Tier } from "./types.js";

// Per-project settings in layers (design 2026-11-01, "Settings resolve in layers"). Pure: the parse and
// gate checks run once at config load; settingsFor resolves one project's effective values on each read.
//
// Order, first hit wins: learned value → project override → `defaults` (or the same key at top level) →
// built-in default. Every per-project key is a gate, so a project override (and a learned value) may only
// tighten it against the global value: the `defaults` layer, else the built-in default.

/** The only keys a project may set. Everything else in a project block is an unknown key. */
export const PROJECT_SETTING_KEYS = ["max_attempts", "max_diff_lines", "max_diff_files", "budgets", "floors"] as const;
export type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[number];

/** A human floor (design §3): touching a path under `prefix` raises the tier to at least `tier`. */
export interface Floor {
  prefix: string;
  tier: Tier;
}

export interface ProjectSettings {
  /** Task failures of one step before it blocks on a human. */
  max_attempts: number;
  /** Pre-push size gate: added plus deleted lines over the whole branch diff. */
  max_diff_lines: number;
  /** Pre-push size gate: changed files over the whole branch diff. */
  max_diff_files: number;
  /** Token budget per tier (design §6). A tier with no entry has no limit. */
  budgets: Budgets;
  /** Human floor directories (design §3). */
  floors: Floor[];
}

/** Where an effective value came from, highest priority first. */
export const SETTING_LAYERS = ["learned", "project", "defaults", "built-in"] as const;
export type SettingLayer = (typeof SETTING_LAYERS)[number];

export const BUILT_IN_SETTINGS: Readonly<ProjectSettings> = Object.freeze({
  max_attempts: 3,
  max_diff_lines: DIFF_LIMIT_DEFAULTS.max_diff_lines,
  max_diff_files: DIFF_LIMIT_DEFAULTS.max_diff_files,
  budgets: {},
  floors: [],
});

/** The checked config layers. Built once at load by `settingsLayers`; core reads them only through settingsFor. */
export interface SettingsLayers {
  /** `defaults` merged with the same keys at top level (setting both is a startup error). */
  defaults: Partial<ProjectSettings>;
  /**
   * Project to its overrides. Keyed by "owner/name" as factory.config.json writes it until startup resolves
   * the repo; the composition root then re-keys it to the project key, as in WorkItem.project (design 2026-11-01).
   */
  projects: Readonly<Record<string, Partial<ProjectSettings>>>;
}

/**
 * The learned layer: values the factory may learn per project. Pluggable; no writer exists yet, so the
 * composition root passes none. A learned value that would loosen a gate past the global value is ignored.
 */
export interface LearnedSettingsSource {
  get<K extends ProjectSettingKey>(project: string, key: K): ProjectSettings[K] | undefined;
}

export type EffectiveSetting<K extends ProjectSettingKey> = { value: ProjectSettings[K]; layer: SettingLayer };
export type EffectiveSettings = { [K in ProjectSettingKey]: EffectiveSetting<K> };

export const NO_SETTINGS: SettingsLayers = Object.freeze({ defaults: {}, projects: {} });

/** The global value of each key: `defaults`, else the built-in default. What a project must not loosen. */
export function globalSettings(layers: SettingsLayers): EffectiveSettings {
  const out = {} as Record<ProjectSettingKey, EffectiveSetting<ProjectSettingKey>>;
  for (const k of PROJECT_SETTING_KEYS) {
    const v = layers.defaults[k];
    out[k] = v === undefined ? { value: BUILT_IN_SETTINGS[k], layer: "built-in" } : { value: v, layer: "defaults" };
  }
  return out as EffectiveSettings;
}

/** Each per-project key's effective value for `project`, and the layer it came from. */
export function settingsFor(project: string, layers: SettingsLayers, learned?: LearnedSettingsSource): EffectiveSettings {
  const global = globalSettings(layers);
  const own = Object.hasOwn(layers.projects, project) ? layers.projects[project]! : {};
  const out = {} as Record<ProjectSettingKey, EffectiveSetting<ProjectSettingKey>>;
  for (const k of PROJECT_SETTING_KEYS) {
    const l = learned?.get(project, k);
    if (l !== undefined && loosening(k, l, global[k].value) === null) out[k] = { value: l, layer: "learned" };
    else if (own[k] !== undefined) out[k] = { value: own[k], layer: "project" };
    else out[k] = global[k];
  }
  return out as EffectiveSettings;
}

/** settingsFor without the layers: the values core code acts on. */
export function settingValues(project: string, layers: SettingsLayers, learned?: LearnedSettingsSource): ProjectSettings {
  const s = settingsFor(project, layers, learned);
  return {
    max_attempts: s.max_attempts.value,
    max_diff_lines: s.max_diff_lines.value,
    max_diff_files: s.max_diff_files.value,
    budgets: s.budgets.value,
    floors: s.floors.value,
  };
}

/** One line per key: `max_attempts = 3 (defaults)`. What doctor and the status page show. */
export function describeSettings(s: EffectiveSettings): string[] {
  return PROJECT_SETTING_KEYS.map((k) => `${k} = ${formatValue(k, s[k].value)} (${s[k].layer})`);
}

function formatValue(key: ProjectSettingKey, value: unknown): string {
  if (key === "floors") {
    const floors = value as Floor[];
    return floors.length === 0 ? "none" : floors.map((f) => `${f.prefix}≥${f.tier}`).join(", ");
  }
  if (key === "budgets") {
    const entries = Object.entries(value as Budgets);
    return entries.length === 0 ? "no limits" : entries.map(([t, n]) => `tier ${t}: ${n}`).join(", ");
  }
  return String(value);
}

/**
 * Why `value` would loosen the gate `key` past `global`, or null when it is equal or tighter. Numbers: not
 * above. Budgets: every global tier kept, none above. Floors: every global prefix kept, none at a lower tier.
 */
export function loosening<K extends ProjectSettingKey>(key: K, value: ProjectSettings[K], global: ProjectSettings[K]): string | null {
  if (key === "budgets") {
    const v = value as Budgets;
    const g = global as Budgets;
    for (const [t, limit] of Object.entries(g) as [string, number][]) {
      const own = v[Number(t) as Tier];
      if (own === undefined) return `removes the global budget for tier ${t} (${limit})`;
      if (own > limit) return `raises the budget for tier ${t} to ${own}, above the global value ${limit}`;
    }
    return null;
  }
  if (key === "floors") {
    const v = value as Floor[];
    for (const f of global as Floor[]) {
      const tiers = v.filter((o) => o.prefix === f.prefix).map((o) => o.tier);
      if (tiers.length === 0) return `removes the global floor "${f.prefix}" (tier ${f.tier})`;
      const top = Math.max(...tiers);
      if (top < f.tier) return `lowers the floor "${f.prefix}" to tier ${top}, below the global tier ${f.tier}`;
    }
    return null;
  }
  const v = value as number;
  const g = global as number;
  return v > g ? `is ${v}, above the global value ${g}` : null;
}

// Load-time parsing and checks. Each throws an Error naming the config path.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTier(n: unknown): n is Tier {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

/** `at` is the key's config path ("max_attempts", "defaults.floors", `projects["o/n"].budgets`). */
export function parseSetting<K extends ProjectSettingKey>(key: K, value: unknown, at: string): ProjectSettings[K] {
  switch (key) {
    case "max_attempts":
    case "max_diff_lines":
    case "max_diff_files":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${at} must be a positive integer`);
      return value as ProjectSettings[K];
    case "budgets": {
      if (!isObject(value)) throw new Error(`${at} must be an object of tier (1–5) to tokens`);
      const out: Budgets = {};
      for (const [t, n] of Object.entries(value)) {
        if (!/^[1-5]$/.test(t)) throw new Error(`${at} key "${t}" must be a tier from 1 to 5`);
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new Error(`${at}.${t} must be a positive integer`);
        out[Number(t) as Tier] = n;
      }
      return out as ProjectSettings[K];
    }
    case "floors": {
      if (!Array.isArray(value)) throw new Error(`${at} must be an array of { prefix, tier }`);
      return value.map((f: unknown, i) => {
        if (!isObject(f) || typeof f.prefix !== "string") throw new Error(`${at}[${i}].prefix must be a string`);
        if (!isTier(f.tier)) throw new Error("tiers must be integers 1–5");
        return { prefix: f.prefix, tier: f.tier };
      }) as ProjectSettings[K];
    }
  }
  throw new Error(`${at}: not a per-project setting`);
}

/** Config path of a key inside a project block. */
export function projectPath(project: string, key: string): string {
  return `projects[${JSON.stringify(project)}].${key}`;
}

/**
 * The checked layers from a parsed factory.config.json (unknown keys already rejected). Fails when a key is
 * set both at top level and in `defaults`, when a project ID is not `configuredProject`, on a bad value, and
 * when a project value loosens a gate past the global value.
 */
export function settingsLayers(raw: Record<string, unknown>, configuredProject: string): SettingsLayers {
  const defaults: Partial<ProjectSettings> = {};
  const rawDefaults = raw.defaults;
  if (rawDefaults !== undefined && !isObject(rawDefaults)) throw new Error("defaults must be an object of per-project setting keys");
  for (const k of PROJECT_SETTING_KEYS) {
    const top = raw[k];
    const def = rawDefaults?.[k];
    if (top !== undefined && def !== undefined) {
      throw new Error(`"${k}" is set both at top level and in defaults; keep one`);
    }
    if (top !== undefined) set(defaults, k, parseSetting(k, top, k));
    else if (def !== undefined) set(defaults, k, parseSetting(k, def, `defaults.${k}`));
  }

  const global = globalSettings({ defaults, projects: {} });
  const projects: Record<string, Partial<ProjectSettings>> = {};
  const rawProjects = raw.projects;
  if (rawProjects !== undefined && !isObject(rawProjects)) throw new Error("projects must be an object keyed by project ID (owner/name)");
  for (const [id, block] of Object.entries(rawProjects ?? {})) {
    if (id !== configuredProject) {
      throw new Error(`project ${JSON.stringify(id)} in projects does not match the configured repo's ID ${JSON.stringify(configuredProject)} (repo.owner/repo.name)`);
    }
    if (!isObject(block)) throw new Error(`projects[${JSON.stringify(id)}] must be an object`);
    const own: Partial<ProjectSettings> = {};
    for (const k of PROJECT_SETTING_KEYS) {
      if (block[k] === undefined) continue;
      const at = projectPath(id, k);
      const v = parseSetting(k, block[k], at);
      const why = loosening(k, v, global[k].value);
      if (why !== null) throw new Error(`${at} ${why}; a project may only tighten a gate`);
      set(own, k, v);
    }
    projects[id] = own;
  }
  return { defaults, projects };
}

function set<K extends ProjectSettingKey>(o: Partial<ProjectSettings>, k: K, v: ProjectSettings[K]): void {
  o[k] = v;
}
