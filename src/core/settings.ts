import type { Budgets } from "./budget.js";
import { ALARM_DEFAULTS, type FactoryConfig, STALL_DEFAULTS, coordinationProblems } from "./config.js";
import { DEFAULT_COORDINATION, type HoldPolicy, parseHoldPolicy } from "./coordination.js";
import { DIFF_LIMIT_DEFAULTS } from "./diff-gate.js";
import { errorText, type Logger } from "./log.js";
import { parseMessageStyle, withMessageStyle } from "./message-style.js";
import { NOTICE_KINDS, type NoticeKind, parseNoticeKinds, parseNotifyChannels, quietHoursSetting } from "./notifications.js";
import { DEFAULT_MODEL_BY, MODEL_RUN_KINDS, type ModelNames, type ModelTable, TIER_KEYS, parseModelBy, parseModels } from "./model-choice.js";
import type { RunId, Tier, Timestamp } from "./types.js";
import type { SettingOverride } from "../interfaces/factory-store.js";

// Per-project settings in layers (design 2026-11-01, "Settings resolve in layers"). Pure: the parse and
// gate checks run once at config load; settingsFor resolves one project's effective values on each read.
//
// Order, first hit wins: learned value → project override → `defaults` (or the same key at top level) →
// built-in default. Every per-project key is a gate: a project override may only tighten it against the global
// value (`defaults`, else built-in), and a learned value against the project override, else the global value.

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

/** The learned layer (src/core/learned-settings.ts), written by the daily improve run. A learned value looser than the project override, else the global value, is ignored. */
export interface LearnedSettingsSource {
  get<K extends ProjectSettingKey>(project: string, key: K): ProjectSettings[K] | undefined;
  /** Why a learned value is there, for the Settings page: the failed runs it was learned from and when it was set. Absent: the source keeps none (the gates need only `get`). */
  record?(project: string, key: ProjectSettingKey): { evidence_run_ids: RunId[]; set_at: Timestamp } | undefined;
}

export type EffectiveSetting<K extends ProjectSettingKey> = { value: ProjectSettings[K]; layer: SettingLayer };
export type EffectiveSettings = { [K in ProjectSettingKey]: EffectiveSetting<K> };

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
    if (l !== undefined && loosening(k, l, own[k] ?? global[k].value) === null) out[k] = { value: l, layer: "learned" };
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTier = (n: unknown): n is Tier => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;

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

function set<K extends ProjectSettingKey>(o: Partial<ProjectSettings>, k: K, v: ProjectSettings[K]): void { o[k] = v; }

// Runtime overrides (design 2026-11-03, "Settings change at runtime"). `factory settings set` stores an override
// in the store; every process reads the overrides through resolveSettings, the one function that gives a
// settable key's effective value: override if set, else the config file value, else the built-in default.
// A global override sits above the file's top-level value, a project override above the file's project block,
// and the learned layer stays on top (settingsFor).

/** The keys `factory settings set` accepts. An allow-list: every other key is refused. */
export const SETTABLE_KEYS = [
  "max_attempts",
  "max_loops", "max_restart",
  "retry_base_ms", "retry_max_ms",
  "max_diff_lines", "max_diff_files",
  "run_timeout_ms", "first_output_ms",
  "models", "model_by",
  "poll_interval_ms", "tick_ms",
  "heartbeat_ms", "lease_ms",
  "workers",
  "phases_auto_approve", "hold_policy",
  "alarm_repeat_count", "alarm_window_minutes", "alarm_restart_count",
  "standing_approvals.threshold",
  "mode", "auto_merge_max_tier",
  "message_style", "notice_kinds", "quiet_hours", "notify_channels", "integrations",
  "stall_ms", "probe_interval_ms", "auth_pause_ms", "max_coordination_cost", "hotspot_weight", "mechanical_weight", "intake_label",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** Settable keys that are per-project gates: a project value may only tighten the global one. */
export const GATE_SETTABLE_KEYS = ["max_attempts", "max_diff_lines", "max_diff_files"] as const;
export type GateSettableKey = (typeof GATE_SETTABLE_KEYS)[number];
/** Settable keys that take `--project`: the gates a project may tighten, and `mode` (design 08-settings). */
export const PROJECT_SETTABLE_KEYS = [...GATE_SETTABLE_KEYS, "mode"] as const;
export type ProjectSettableKey = (typeof PROJECT_SETTABLE_KEYS)[number];
export type GlobalSettableKey = Exclude<SettableKey, ProjectSettableKey>;

/** The factory's two modes (design 03-risk): `manual` waits for a person at both gates; `auto` may pass them itself. */
export const MODES = ["manual", "auto"] as const;
export type Mode = (typeof MODES)[number];
/** The highest `auto_merge_max_tier` the setting takes: tier 4 and up never merge automatically. */
export const AUTO_MERGE_TIER_MAX = 3;
/** Keys whose change needs `approve_merge` on the project (design 08-settings): they decide what merges without a person. */
export const APPROVE_MERGE_KEYS: readonly SettableKey[] = ["mode", "auto_merge_max_tier"];
/** Keys only the owner changes, free and with no grant (design 08-settings): `integrations` switches a plugin the factory runs. */
export const OWNER_KEYS: readonly SettableKey[] = ["integrations"];

/** Keys that change only by a reviewed PR to factory.config.json (guards and secrets included). */
export const PR_ONLY_KEYS = [
  "plugins", "repo", "store", "floors", "dials", "auth", "permissions", "secrets", "egress", "broker", "deny_paths", "env", "toolchain",
  "outbound.batching", "merge_queue.depth", "hooks", "packs.auto_approve_read_only",
] as const;
export type PrOnlyKey = (typeof PR_ONLY_KEYS)[number];

// What each key controls and when a change applies live in its `*.setting.ts` file (RFC 0015 M10), read through
// the settings catalog (src/runtime); tests/settings-catalog.test.ts holds the key lists here and the catalog equal.

export interface SettableValues {
  max_attempts: number;
  max_loops: number; max_restart: number;
  retry_base_ms: number; retry_max_ms: number;
  max_diff_lines: number;
  max_diff_files: number;
  run_timeout_ms: number;
  first_output_ms: number;
  models: ModelNames;
  model_by: ModelTable;
  poll_interval_ms: number;
  tick_ms: number;
  heartbeat_ms: number;
  lease_ms: number;
  workers: number;
  phases_auto_approve: boolean;
  hold_policy: HoldPolicy;
  alarm_repeat_count: number;
  alarm_window_minutes: number;
  alarm_restart_count: number;
  "standing_approvals.threshold": number;
  mode: Mode;
  auto_merge_max_tier: number;
  message_style: string;
  notice_kinds: NoticeKind[]; quiet_hours: string; notify_channels: string[];
  integrations: Readonly<Record<string, string>>; // interface → plugin name; no entry: the config's choice (design 08-settings)
  stall_ms: number; probe_interval_ms: number; auth_pause_ms: number;
  max_coordination_cost: number; hotspot_weight: number; mechanical_weight: number;
  intake_label: string | null; // null: no built-in default, and neither the file nor an override says
}

/** The built-in default of each settable key, in the form factory.config.json writes it. */
export const SETTABLE_DEFAULTS: Readonly<Record<SettableKey, unknown>> = Object.freeze({
  max_attempts: BUILT_IN_SETTINGS.max_attempts,
  max_loops: 3,
  max_restart: 3,
  retry_base_ms: 60_000,
  retry_max_ms: 1_800_000,
  max_diff_lines: BUILT_IN_SETTINGS.max_diff_lines,
  max_diff_files: BUILT_IN_SETTINGS.max_diff_files,
  run_timeout_ms: 2_700_000,
  first_output_ms: STALL_DEFAULTS.first_output_ms,
  models: { cheap: "haiku", standard: "sonnet", strong: "opus" },
  model_by: DEFAULT_MODEL_BY,
  poll_interval_ms: 30_000,
  tick_ms: 2_000,
  heartbeat_ms: 60_000,
  lease_ms: 300_000,
  workers: 1,
  phases_auto_approve: false,
  hold_policy: DEFAULT_COORDINATION.hold_policy,
  ...ALARM_DEFAULTS,
  "standing_approvals.threshold": 10,
  mode: "manual",
  auto_merge_max_tier: 0,
  message_style: "",
  notice_kinds: [...NOTICE_KINDS], quiet_hours: "", notify_channels: [], integrations: {},
  stall_ms: STALL_DEFAULTS.stall_ms, probe_interval_ms: STALL_DEFAULTS.probe_interval_ms,
  auth_pause_ms: 1_800_000, // shown as the default; with no override and no file value it follows the effective retry_max_ms
  max_coordination_cost: DEFAULT_COORDINATION.max_cost, hotspot_weight: DEFAULT_COORDINATION.hotspot_weight, mechanical_weight: DEFAULT_COORDINATION.mechanical_weight,
  intake_label: null, // no built-in default: the config file must say, and its value applies
});

export const HEARTBEAT_LEASE_MESSAGE = "heartbeat_ms must be well under lease_ms";
export const RETRY_ORDER_MESSAGE = "retry_base_ms must not exceed retry_max_ms";

export const isSettableKey = (key: string): key is SettableKey => (SETTABLE_KEYS as readonly string[]).includes(key);
export const isProjectSettableKey = (key: string): key is ProjectSettableKey => (PROJECT_SETTABLE_KEYS as readonly string[]).includes(key);
export const isGateSettableKey = (key: string): key is GateSettableKey => (GATE_SETTABLE_KEYS as readonly string[]).includes(key);
export const isPrOnlyKey = (key: string): boolean => (PR_ONLY_KEYS as readonly string[]).includes(key);

/** Why `settings set` / `reset` refuses `key`, or null when it is settable. */
export function keyRefusal(key: string): string | null {
  if (isSettableKey(key)) return null;
  if (isPrOnlyKey(key)) return `"${key}" changes by PR only: edit factory.config.json in a reviewed change`;
  return `"${key}" is not settable; the settable keys are ${SETTABLE_KEYS.join(", ")}`;
}

/** `workers` from factory.config.json: absent means 1, otherwise an integer of 1 or more or startup fails. */
export function workerCount(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`workers must be an integer of 1 or more (got ${JSON.stringify(value) ?? String(value)})`);
  }
  return value;
}

/**
 * `max_workers` from factory.config.json: the worker slots a process has, which sizes the supervisor's worker
 * index block. Absent means `workers`; otherwise an integer of at least `workers` or startup fails. The live
 * `workers` setting may go anywhere from 1 to this without a restart.
 */
export function maxWorkers(workers: number, value: unknown): number {
  if (value === undefined) return workers;
  if (typeof value !== "number" || !Number.isInteger(value) || value < workers) {
    throw new Error(`max_workers must be an integer of at least workers (${workers}) (got ${JSON.stringify(value) ?? String(value)})`);
  }
  return value;
}

/** A boolean, or the config loader's message for `key`. */
export function booleanSetting(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  return value;
}

/** A positive integer, or the config loader's message for `key`. */
export function positiveInteger(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

/** `intake_label`: a non-empty string, or the config loader's message. */
export function intakeLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`intake_label must be a non-empty string (got ${JSON.stringify(value) ?? String(value)})`);
  return value;
}

/** Checks one settable value; throws the message the config loader gives for that key. */
export function parseSettable<K extends SettableKey>(key: K, value: unknown): SettableValues[K] {
  switch (key) {
    case "max_attempts":
    case "max_diff_lines":
    case "max_diff_files":
      return parseSetting(key as GateSettableKey, value, key) as SettableValues[K];
    case "models":
      return parseModels(value) as SettableValues[K];
    case "model_by":
      if (value === undefined) throw new Error("model_by must be an object");
      return parseModelBy(value) as SettableValues[K];
    case "workers":
      if (value === undefined) throw new Error("workers must be an integer of 1 or more (got undefined)");
      return workerCount(value) as SettableValues[K];
    case "phases_auto_approve": return booleanSetting(key, value) as SettableValues[K];
    case "hold_policy":
      return parseHoldPolicy(value) as SettableValues[K];
    case "mode":
      if (!(MODES as readonly unknown[]).includes(value)) throw new Error(`mode must be ${MODES.map((m) => `"${m}"`).join(" or ")}`);
      return value as SettableValues[K];
    case "auto_merge_max_tier":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > AUTO_MERGE_TIER_MAX) {
        throw new Error(`auto_merge_max_tier must be a whole number from 0 to ${AUTO_MERGE_TIER_MAX}; tier 4 and the gate list never merge automatically`);
      }
      return value as SettableValues[K];
    case "message_style":
      return parseMessageStyle(value) as SettableValues[K];
    case "notice_kinds": return parseNoticeKinds(value) as SettableValues[K];
    case "quiet_hours": return quietHoursSetting(value) as SettableValues[K];
    case "notify_channels": return parseNotifyChannels(value) as SettableValues[K];
    case "integrations": return integrationEntries(value) as SettableValues[K];
    case "max_coordination_cost": case "hotspot_weight": case "mechanical_weight": {
      const problem = coordinationProblems({ [key]: value ?? null })[0];
      if (problem) throw new Error(problem);
      return value as SettableValues[K];
    }
    case "intake_label": return (value === null ? null : intakeLabel(value)) as SettableValues[K]; // null: none, the file's applies
    default:
      return positiveInteger(key, value) as SettableValues[K];
  }
}

/** `integrations` as stored: interface → plugin name. Which are valid is the registry's to say (plugins.ts checkIntegrations, on set). */
function integrationEntries(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((n) => typeof n !== "string" || n.trim() === "")) throw new Error("integrations must be an object from interface to plugin name");
  return { ...(v as Record<string, string>) };
}

/** A ModelTable back in the form `model_by` is written in, so it can be checked and stored like any value. */
export function modelByRaw(table: ModelTable): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of MODEL_RUN_KINDS) out[kind] = Object.fromEntries(TIER_KEYS.map((t) => [t, table.by[kind][Number(t) as Tier]]));
  out.retry_up = table.retry_up;
  return out;
}

export type SettingSource = "override" | "file" | "default";

/** What the config file says, before any override. Checked at load. */
export interface SettingsBase {
  /** The global keys the file sets, as written there. A key that is absent takes its built-in default. */
  file: Partial<Record<GlobalSettableKey, unknown>>;
  /** The file's per-project layers: `defaults` holds the file's global value of each per-project key. */
  layers: SettingsLayers;
  /** The file's `max_workers` (absent: the file's `workers`): no `workers` override goes above it. */
  max_workers?: number;
}

export interface ResolvedSetting<K extends SettableKey = SettableKey> {
  value: SettableValues[K];
  /** The value as written (file, override or default), for display. */
  raw: unknown;
  source: SettingSource;
}

export interface IgnoredOverride {
  key: string;
  project: string;
  value: string;
  reason: string;
}

export interface ResolvedSettings {
  /** Each key's global effective value and its source. `workers` is not capped here. */
  global: { [K in SettableKey]: ResolvedSetting<K> };
  /** The values the factory acts on: `global` with `workers` capped at `workers_cap`. */
  values: SettableValues;
  /** The per-project layers with the overrides applied, for settingsFor. */
  layers: SettingsLayers;
  /** Per project with a file block or a project override: the value and source of each key it sets. */
  projects: Record<string, Partial<Record<ProjectSettableKey, { value: number | Mode; source: "override" | "file" }>>>;
  /** Stored overrides that failed a check, with the reason. Their key keeps the file value. */
  ignored: IgnoredOverride[];
  /** The file's `max_workers` (else its `workers`, else 1): sizes the supervisor's index block, so no override goes above it. */
  workers_cap: number;
}

type OverrideRow = Pick<SettingOverride, "key" | "project" | "value">;

const CROSS_CHECKS: readonly { keys: readonly [SettableKey, SettableKey]; bad: (v: SettableValues) => boolean; message: string }[] = [
  { keys: ["heartbeat_ms", "lease_ms"], bad: (v) => v.heartbeat_ms * 2 >= v.lease_ms, message: HEARTBEAT_LEASE_MESSAGE },
  { keys: ["retry_base_ms", "retry_max_ms"], bad: (v) => v.retry_base_ms > v.retry_max_ms, message: RETRY_ORDER_MESSAGE },
];

/**
 * The effective value of every settable key: override if set, else the config file value, else the built-in
 * default. The one function the controller, the worker pool and `factory settings` read settings through.
 * A stored override that fails a check (bad JSON or value, heartbeat × 2 ≥ lease, base above max, a project
 * value that would loosen its gate past the global value) is left out and reported in `ignored`; its key keeps
 * the file value. `label` names a project in a reason (default: the project string itself).
 */
export function resolveSettings(base: SettingsBase, overrides: readonly OverrideRow[], label: (project: string) => string = (p) => p): ResolvedSettings {
  const ignored: IgnoredOverride[] = [];
  const ignore = (o: OverrideRow, reason: string) => ignored.push({ key: o.key, project: o.project, value: o.value, reason });
  const globalOv = new Map<SettableKey, { o: OverrideRow; value: unknown; raw: unknown }>();
  const projectOv: { o: OverrideRow; key: ProjectSettableKey; value: number | Mode }[] = [];
  for (const o of overrides) {
    const refused = keyRefusal(o.key);
    if (refused) {
      ignore(o, refused);
      continue;
    }
    const key = o.key as SettableKey;
    if (o.project !== "" && !isProjectSettableKey(key)) {
      ignore(o, `${key} has no per-project value; only ${PROJECT_SETTABLE_KEYS.join(", ")} do`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(o.value);
    } catch {
      ignore(o, `${key}: the stored value is not JSON`);
      continue;
    }
    let value: unknown;
    try {
      value = parseSettable(key, raw);
    } catch (err) {
      ignore(o, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (o.project === "") globalOv.set(key, { o, value, raw });
    else projectOv.push({ o, key: key as ProjectSettableKey, value: value as number | Mode });
  }

  const fromFile = (k: SettableKey): ResolvedSetting => {
    const f = isGateSettableKey(k) ? base.layers.defaults[k] : isProjectSettableKey(k) ? undefined : base.file[k];
    return f === undefined
      ? { value: parseSettable(k, SETTABLE_DEFAULTS[k]), raw: SETTABLE_DEFAULTS[k], source: "default" }
      : { value: parseSettable(k, f), raw: f, source: "file" };
  };
  const build = () => {
    const g = {} as Record<SettableKey, ResolvedSetting>;
    for (const k of SETTABLE_KEYS) {
      const ov = globalOv.get(k);
      g[k] = ov ? { value: ov.value as SettableValues[typeof k], raw: ov.raw, source: "override" } : fromFile(k);
    }
    if (g.auth_pause_ms.source === "default") g.auth_pause_ms = { ...g.retry_max_ms, source: "default" }; // follows retry_max_ms (05-restarts)
    return g as ResolvedSettings["global"];
  };
  const valuesOf = (g: ResolvedSettings["global"]) =>
    Object.fromEntries(SETTABLE_KEYS.map((k) => [k, g[k].value])) as unknown as SettableValues;
  const drop = (k: SettableKey, reason: string) => {
    const ov = globalOv.get(k);
    if (!ov) return;
    ignore(ov.o, reason);
    globalOv.delete(k);
  };

  let global = build();
  for (const c of CROSS_CHECKS) {
    if (!c.bad(valuesOf(global))) continue;
    for (const k of c.keys) drop(k, c.message);
    global = build();
  }
  // A global override may not leave a project's file value looser than itself (it would be refused at load).
  for (const k of GATE_SETTABLE_KEYS) {
    const ov = globalOv.get(k);
    if (!ov) continue;
    for (const [p, block] of Object.entries(base.layers.projects)) {
      const own = block[k];
      if (own !== undefined && loosening(k, own, ov.value as number) !== null) {
        drop(k, `${k} ${String(ov.value)} would leave ${projectPath(label(p), k)} (${own}) looser than the global value; a project may only tighten a gate`);
        break;
      }
    }
  }
  global = build();

  const defaults: Partial<ProjectSettings> = { ...base.layers.defaults };
  for (const k of GATE_SETTABLE_KEYS) if (globalOv.has(k)) defaults[k] = global[k].value;
  const projects: Record<string, Partial<ProjectSettings>> = {};
  const sources: ResolvedSettings["projects"] = {};
  for (const [p, block] of Object.entries(base.layers.projects)) {
    projects[p] = { ...block };
    for (const k of GATE_SETTABLE_KEYS) {
      const v = block[k];
      if (v !== undefined) (sources[p] ??= {})[k] = { value: v, source: "file" };
    }
  }
  for (const po of projectOv) {
    // `mode` is no gate (design 08-settings): a project's mode stands on its own, outside the per-project layers.
    if (isGateSettableKey(po.key)) {
      const why = loosening(po.key, po.value as number, global[po.key].value);
      if (why !== null) {
        ignore(po.o, `${projectPath(label(po.o.project), po.key)} ${why}; a project may only tighten a gate`);
        continue;
      }
      projects[po.o.project] = { ...projects[po.o.project], [po.key]: po.value };
    }
    (sources[po.o.project] ??= {})[po.key] = { value: po.value, source: "override" };
  }

  const workers_cap = workersCap(base);
  const values = { ...valuesOf(global), workers: Math.min(global.workers.value, workers_cap) };
  return { global, values, layers: { defaults, projects }, projects: sources, ignored, workers_cap };
}

/** One key's effective value: for `project`, its own value where it has one, else the global value. */
export function effectiveSetting<K extends SettableKey>(r: ResolvedSettings, key: K, project = ""): ResolvedSetting<K> {
  if (project !== "" && isProjectSettableKey(key)) {
    const own = r.projects[project]?.[key];
    if (own) return { value: own.value as SettableValues[K], raw: own.value, source: own.source };
  }
  if (key === "workers") return { ...r.global.workers, value: r.values.workers } as ResolvedSetting<K>;
  return r.global[key];
}

/**
 * A project's mode (design 03-risk): its own override, else the global override, else `manual`. `level`: the
 * override row's project ("" global) the mode is stored in, so a stop writes that row; null when none is stored.
 */
export function modeOf(r: ResolvedSettings, project: string): { mode: Mode; level: string | null } {
  if (r.projects[project]?.mode) return { mode: r.projects[project].mode.value as Mode, level: project };
  const g = r.global.mode;
  return { mode: g.value, level: g.source === "override" ? "" : null };
}

/** The most worker slots a process has: the file's `max_workers`, else its `workers`, else 1. */
export function workersCap(base: SettingsBase): number {
  return base.max_workers ?? parseSettable("workers", base.file.workers ?? SETTABLE_DEFAULTS.workers);
}

/** The base a FactoryConfig alone gives: every key from the config, as if the file set it. For tests and lone loops. */
export function baseFromConfig(config: FactoryConfig, models?: { table: ModelTable; names?: ModelNames | undefined }): SettingsBase {
  const file: Partial<Record<GlobalSettableKey, unknown>> = { intake_label: config.intake_label };
  for (const k of CONFIG_KEYS) if (config[k] !== undefined) file[k] = config[k];
  const c = config.coordination;
  if (c) Object.assign(file, { hold_policy: c.hold_policy, max_coordination_cost: c.max_cost, hotspot_weight: c.hotspot_weight, mechanical_weight: c.mechanical_weight });
  if (models) file.model_by = modelByRaw(models.table);
  if (models?.names) file.models = models.names;
  return { file, layers: config.settings, ...(config.max_workers !== undefined ? { max_workers: config.max_workers } : {}) };
}

/** The settable keys a FactoryConfig holds under their own name: baseFromConfig reads them, the live view writes them. */
const CONFIG_KEYS = [
  "max_loops", "max_restart", "retry_base_ms", "retry_max_ms", "run_timeout_ms", "first_output_ms", "poll_interval_ms", "tick_ms", "heartbeat_ms",
  "lease_ms", "workers", "phases_auto_approve", "alarm_repeat_count", "alarm_window_minutes", "alarm_restart_count", "stall_ms", "probe_interval_ms", "auth_pause_ms",
] as const satisfies readonly (GlobalSettableKey & keyof FactoryConfig)[];

/** Reads the stored overrides; the store's FactoryStore.listSettingOverrides. */
export interface OverrideSource {
  listSettingOverrides(): Promise<SettingOverride[]>;
}

/**
 * The settings a running process acts on. refresh() re-reads the stored overrides and learned values (the controller each tick,
 * the worker pool each tick, a worker before each claim and each lease renewal) and hands `integrations` to the plugin holders
 * (src/runtime/live-tacit.ts); the getters return the last resolved values without I/O. Only a cache of store rows: no replica
 * needs it, and a restart rebuilds it. A failed read keeps the values in use; an override that fails a check is logged once and ignored.
 */
export class LiveSettings {
  private current: ResolvedSettings;
  private view: FactoryConfig;
  private readonly reported = new Set<string>();

  constructor(
    private readonly opts: {
      config: FactoryConfig; base: SettingsBase; source?: OverrideSource | null; learned?: { refresh(): Promise<void> }; log?: Logger; integrations?: readonly { apply(e: Readonly<Record<string, string>>): Promise<void> }[];
    },
  ) {
    this.current = resolveSettings(opts.base, [], this.label);
    this.view = this.viewOf(this.current);
  }

  /** No stored overrides: the config's values, fixed. What a Worker or Controller built without settings uses. */
  static fixed(config: FactoryConfig, models?: { table: ModelTable; names?: ModelNames | undefined }): LiveSettings {
    return new LiveSettings({ config, base: baseFromConfig(config, models) });
  }

  async refresh(): Promise<void> {
    await this.opts.learned?.refresh(); // the learned layer's cache (StoredLearnedSettings), which keeps its values on a failed read
    const source = this.opts.source;
    if (!source) return;
    let rows: SettingOverride[];
    try {
      rows = await source.listSettingOverrides();
    } catch (err) {
      this.opts.log?.warn("settings overrides could not be read; keeping the values in use", {
        error: errorText(err),
      });
      return;
    }
    this.current = resolveSettings(this.opts.base, rows, this.label);
    this.view = this.viewOf(this.current);
    for (const h of this.opts.integrations ?? []) await h.apply(this.current.values.integrations);
    for (const i of this.current.ignored) {
      const sig = JSON.stringify([i.key, i.project, i.value]);
      if (this.reported.has(sig)) continue;
      this.reported.add(sig);
      this.opts.log?.warn("settings override ignored; the file value stays in use", { key: i.key, project: i.project || null, reason: i.reason });
    }
  }

  /** The config with every settable key at its effective value. */
  config(): FactoryConfig {
    return this.view;
  }

  values(): SettableValues {
    return this.current.values;
  }

  resolved(): ResolvedSettings {
    return this.current;
  }

  /** `system` with the owner's `message_style` after it, as it stands now (design 04-agents); empty: `system` unchanged. */
  styled(system: string): string {
    return withMessageStyle(system, this.current.values.message_style);
  }

  /** Worker slots that may claim: the effective `workers`, capped at the file's `max_workers`. */
  workers(): number {
    return this.current.values.workers;
  }

  /** The model table and, unless no config names them, the model name per class. */
  models(): { table: ModelTable; names?: ModelNames } {
    const r = this.current;
    return r.global.models.source === "default" ? { table: r.values.model_by } : { table: r.values.model_by, names: r.values.models };
  }

  private readonly label = (project: string): string => (project === this.opts.config.project.key ? this.opts.config.project.label : project);

  private viewOf(r: ResolvedSettings): FactoryConfig {
    const v = r.values;
    const c = this.opts.config.coordination;
    // The settable coordination keys live in the claim's coordination settings; a config with none and no override keeps none.
    const live = c || (["hold_policy", "max_coordination_cost", "hotspot_weight", "mechanical_weight"] as const).some((k) => r.global[k].source !== "default");
    const coordination = { ...(c ?? DEFAULT_COORDINATION), hold_policy: v.hold_policy, max_cost: v.max_coordination_cost, hotspot_weight: v.hotspot_weight, mechanical_weight: v.mechanical_weight };
    return {
      ...this.opts.config,
      ...(live ? { coordination } : {}),
      intake_label: v.intake_label ?? this.opts.config.intake_label, // null: no file value and no override, the config's own stays
      settings: r.layers,
      ...(Object.fromEntries(CONFIG_KEYS.map((k) => [k, v[k]])) as Pick<SettableValues, (typeof CONFIG_KEYS)[number]>),
    };
  }
}
