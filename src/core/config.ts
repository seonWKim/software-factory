import { type CoordinationSettings, DEFAULT_COORDINATION } from "./coordination.js";
import type { ProjectRef } from "./project.js";
import type { SettingsLayers } from "./settings.js";
import type { Tier, VerdictSeverity } from "./types.js";

/**
 * The `stats` key of factory.config.json (design §6 Measurement). Read only by `factory stats`; it changes
 * no dial. Every weight is required (non-negative number); `min_sample` is an integer ≥ 1, default 10.
 */
export interface StatsConfig {
  /** Feedback weight per `/verdict` severity. */
  weights: Record<VerdictSeverity, number>;
  /** A tier with fewer closed items than this shows no rate. */
  min_sample: number;
}

/**
 * Runtime config for core code. Built by the composition root; core never reads env or files itself.
 * `project` is the configured repo resolved through the forge at startup (design 2026-11-01): every write
 * and lookup uses its key, every comment and log line its label.
 */
export interface FactoryConfig extends LoadedConfig {
  project: ProjectRef;
}

/**
 * The config as loaded from factory.config.json, before startup resolves the configured repo to its project
 * key. `settings.projects` is still keyed by `owner/name` here; the composition root re-keys it.
 */
export interface LoadedConfig {
  /**
   * `install_command` and `test_command`: argv (no shell) of the gate commands. Defaults ["npm", "ci"] and
   * ["npm", "test"]. `check_commands`: the pre-push checks, a list of argv run in order before every push
   * (design §4): the implement run before push (and in its merge-conflict step), the update run on the merged
   * branch, the resolve run after install. Absent: `[test_command]` (checkCommands in src/core/checks.ts).
   */
  repo: {
    owner: string;
    name: string;
    path: string;
    base_branch: string;
    install_command: string[];
    test_command: string[];
    check_commands?: string[][];
  };
  intake_label: string;
  /** Status labels are this prefix plus a fixed suffix, e.g. "sf: needs approval". Default "sf: ". */
  status_label_prefix: string;
  /** Factory PR branches are `${branch_prefix}${work_item_id}`. The broker pushes nowhere else. */
  branch_prefix: string;
  dials: { spec_gate_min_tier: Tier; auto_merge_max_tier: 0 };
  /**
   * The per-project gate settings in layers: max_attempts, max_diff_lines, max_diff_files, budgets, floors
   * (design 2026-11-01). Read only through settingsFor / settingValues (src/core/settings.ts), never directly.
   */
  settings: SettingsLayers;
  max_loops: number;
  /** Infra failures (lease loss, timeout, exception) of one step before it blocks on a human. Default 3. */
  max_restart: number;
  /** First automatic retry waits this long; each next one twice as long. Default 60000. */
  retry_base_ms: number;
  /** Cap on a retry wait, and the pause after a rate limit with no reset time. Default 1800000. */
  retry_max_ms: number;
  /**
   * How long a forge 401/403 pauses implement-type claims (design §5 Restarts). Absent: `retry_max_ms`.
   */
  auth_pause_ms?: number;
  /**
   * Stall detection (design §5 Restarts): an agent run that prints nothing for this long, with no tool call
   * open, ends `stalled`. Absent: DEFAULT_STALL_MS (300000).
   */
  stall_ms?: number;
  /** How often a stall pause probes the cheap model; a failed probe moves the pause this much later. Absent: 600000. */
  probe_interval_ms?: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /**
   * Stream intake: inbox rows older than this many days, and already behind their source's inbox cursor,
   * are deleted by the controller's cleanup. Default 14.
   */
  inbox_retention_days: number;
  /** Worker loops in one `dev` or `worker` process (architecture §4). An integer of 1 or more; default 1. */
  workers: number;
  /** Paths agent runs may never read (G3/G4). Absolute. */
  deny_paths: string[];
  agent_git_identity: { name: string; email: string };
  /** Finished items a tier needs before budget suggestions come from its history. Absent: 10. */
  budget_min_sample?: number;
  /**
   * Coordination (design §5, 2026-11-03): `max_coordination_cost`, `hotspot_paths`, `hotspot_weight` from
   * factory.config.json, checked at load by `coordinationConfig`. Absent: DEFAULT_COORDINATION.
   */
  coordination?: CoordinationSettings;
}

/** `stall_ms` and `probe_interval_ms` when factory.config.json gives none (design §5 Restarts). */
export const STALL_DEFAULTS = { stall_ms: 300_000, probe_interval_ms: 600_000 } as const;

/** The coordination keys of factory.config.json (design §5, 2026-11-03). */
export const COORDINATION_KEYS = ["max_coordination_cost", "hotspot_paths", "hotspot_weight"] as const;

/**
 * The coordination settings from the top level of factory.config.json, or why they are invalid. Each key is
 * optional (absent: its default). `max_coordination_cost` and `hotspot_weight` must be numbers above 0; zero,
 * a negative or a non-numeric value fails at startup, like the other numeric keys. `hotspot_paths` is a list of
 * non-empty paths (a folder ends in `/`).
 */
export function coordinationProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["max_coordination_cost", "hotspot_weight"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      problems.push(`${key} must be a number above 0 (got ${JSON.stringify(v) ?? String(v)})`);
    }
  }
  const h = r.hotspot_paths;
  if (h !== undefined && (!Array.isArray(h) || !h.every((p) => typeof p === "string" && p.trim() !== ""))) {
    problems.push("hotspot_paths must be a list of non-empty paths");
  }
  return problems;
}

/** The checked coordination settings; throws the first problem `coordinationProblems` finds. */
export function coordinationConfig(raw: unknown): CoordinationSettings {
  const problems = coordinationProblems(raw);
  if (problems.length > 0) throw new Error(problems[0]);
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    max_cost: (r.max_coordination_cost as number | undefined) ?? DEFAULT_COORDINATION.max_cost,
    hotspots: (r.hotspot_paths as string[] | undefined) ?? DEFAULT_COORDINATION.hotspots,
    hotspot_weight: (r.hotspot_weight as number | undefined) ?? DEFAULT_COORDINATION.hotspot_weight,
  };
}

/** The `updater` key of factory.config.json (design §8 Self-update). */
export interface UpdaterConfig {
  /** Drain, run the target's `npm run migrate`, then start it, with no owner command. Default false. */
  auto_migrate: boolean;
}

export const UPDATER_KEYS = ["auto_migrate"] as const;

/**
 * Problems with the `updater` key: absent is fine; otherwise an object whose only key is `auto_migrate`, a
 * boolean. A typo or a non-boolean fails at startup, like the other keys.
 */
export function updaterProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["updater must be an object, e.g. {\"auto_migrate\": false}"];
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(UPDATER_KEYS as readonly string[]).includes(key)) problems.push(`unknown config key "${key}" at updater.${key}; valid updater keys: ${UPDATER_KEYS.join(", ")}`);
  }
  const v = (raw as Record<string, unknown>).auto_migrate;
  if (v !== undefined && typeof v !== "boolean") problems.push(`updater.auto_migrate must be true or false (got ${JSON.stringify(v) ?? String(v)})`);
  return problems;
}

/** The checked `updater` settings; throws the first problem `updaterProblems` finds. Absent: auto_migrate off. */
export function updaterConfig(raw: unknown): UpdaterConfig {
  const problems = updaterProblems(raw);
  if (problems.length > 0) throw new Error(problems[0]);
  return { auto_migrate: (raw as { auto_migrate?: boolean } | undefined)?.auto_migrate === true };
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
  /** prompts/resolve.md. Absent when the file is missing; a resolve run then fails with `prompt_missing`. */
  resolve?: string;
}
