import type { PathCompanion } from "./companions.js";
import { type CoordinationSettings, DEFAULT_COORDINATION, type HotspotMode, HOTSPOT_MODES, parseHoldPolicy } from "./coordination.js";
import type { ProjectRef } from "./project.js";
import type { SettingsLayers } from "./settings.js";
import { isUnder } from "./tools/paths.js";
import type { RunKind, Tier, UserId, VerdictSeverity } from "./types.js";
import type { ToolBroker } from "../interfaces/tool-broker.js";

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
  /**
   * Broker tools granted to agent runs, per run kind: `tool_grants` from factory.config.json, checked at startup
   * against the broker (`toolGrantsConfig`). Absent: no run gets a tool; a kind with no entry gets none either.
   */
  tool_grants?: ToolGrants;
}

/** The run kinds `tool_grants` may name: every kind a worker or the controller records, but `interactive`. */
export const GRANT_RUN_KINDS = ["triage", "implement", "review", "update", "resolve", "manual"] as const satisfies readonly RunKind[];
export type GrantRunKind = (typeof GRANT_RUN_KINDS)[number];

/** Checked `tool_grants`: read-only broker tool names per run kind. */
export type ToolGrants = Partial<Record<GrantRunKind, readonly string[]>>;

/** The tool names granted to one run kind; none when config grants none or the kind has no entry. */
export function grantsFor(grants: ToolGrants | undefined, kind: RunKind): readonly string[] {
  return (GRANT_RUN_KINDS as readonly RunKind[]).includes(kind) ? (grants?.[kind as GrantRunKind] ?? []) : [];
}

/**
 * The `tool_grants` key of factory.config.json, checked against the broker built at startup (not in loadConfig:
 * the broker's tool list comes from its plugin). Absent: undefined, so every run gets an empty grant list. Fails
 * with every problem at once, one per line: a key that is not a run kind (the error lists the run kinds), a tool
 * the broker does not list, or one that is not read-only (both list the valid read-only tool names).
 */
export function toolGrantsConfig(raw: unknown, broker: Pick<ToolBroker, "allTools">, brokerName = "configured"): ToolGrants | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`tool_grants must be an object mapping a run kind (${GRANT_RUN_KINDS.join(", ")}) to a list of broker tool names`);
  }
  const tools = broker.allTools();
  const readOnly = tools.filter((t) => t.read_only).map((t) => t.name);
  const valid = `valid read-only tools of the ${brokerName} broker: ${readOnly.length > 0 ? readOnly.join(", ") : "(none)"}`;
  const problems: string[] = [];
  const out: ToolGrants = {};
  for (const [kind, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!(GRANT_RUN_KINDS as readonly string[]).includes(kind)) {
      problems.push(`tool_grants key ${JSON.stringify(kind)} is not a run kind; run kinds: ${GRANT_RUN_KINDS.join(", ")}`);
      continue;
    }
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n !== "")) {
      problems.push(`tool_grants.${kind} must be a list of broker tool names; ${valid}`);
      continue;
    }
    for (const name of names as string[]) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) problems.push(`tool_grants.${kind} grants ${JSON.stringify(name)}, which the ${brokerName} broker does not list; ${valid}`);
      else if (!tool.read_only) problems.push(`tool_grants.${kind} grants ${JSON.stringify(name)}, which is not read-only (only read-only tools may be granted); ${valid}`);
    }
    out[kind as GrantRunKind] = [...new Set(names as string[])];
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return out;
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
   * The merge command (design §4, issue #246): true when factory.config.json names a forge itself in
   * `plugins.forge` (not one derived from `plugins.source`), so a project turns it on by writing that setting.
   * Absent or false: no Merge button, and an app `merge` request is refused with a pointer to GitHub.
   */
  forge_merge?: boolean;
  /**
   * The per-project gate settings in layers: max_attempts, max_diff_lines, max_diff_files, budgets, floors
   * (design 2026-11-01). Read only through settingsFor / settingValues (src/core/settings.ts), never directly.
   */
  settings: SettingsLayers;
  max_loops: number;
  /**
   * Split phases (design 2026-11-01): when true, a phase's spec needs no `/approve` of its own, since the owner
   * approved the split on the parent. Live setting (`settings set phases_auto_approve true`). Absent: false.
   */
  phases_auto_approve?: boolean;
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
   * Stall detection (design §5 Restarts): an agent run whose model produces no output for this long, with no
   * tool call open, ends `stalled`. Absent: STALL_DEFAULTS.stall_ms (300000).
   */
  stall_ms?: number;
  /**
   * First-output limit (design §5 Restarts, issue #215): an agent run whose model produces no output within
   * this long of the start ends `stalled`. Settable live. Absent: STALL_DEFAULTS.first_output_ms (180000).
   */
  first_output_ms?: number;
  /** How often a stall pause probes the cheap model; a failed probe moves the pause this much later. Absent: 600000. */
  probe_interval_ms?: number;
  /**
   * The alarm step (design 05-alarms): matching runs on distinct items (and zero-token agent runs in a row) that
   * raise an alert, the minutes they are counted over, and the child restarts within 30 minutes that raise one.
   * Settable live. Absent: ALARM_DEFAULTS.
   */
  alarm_repeat_count?: number;
  alarm_window_minutes?: number;
  alarm_restart_count?: number;
  /**
   * The most times the gate hooks' Stop hook sends an implement run's agent back in one run (design §4, issue
   * #302); the next stop is allowed. A positive integer. Absent: AGENT_STOP_CHECKS_DEFAULT (3).
   */
  agent_stop_checks?: number;
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
  /**
   * Worker slots in one process, the most `workers` can be raised to live (`factory settings set workers`).
   * Sizes the supervisor's worker index block. An integer of at least `workers`; absent: `workers`.
   */
  max_workers?: number;
  /** Paths agent runs may never read (G3/G4). Absolute. */
  deny_paths: string[];
  agent_git_identity: { name: string; email: string };
  /** Finished items a tier needs before budget suggestions come from its history. Absent: 10. */
  budget_min_sample?: number;
  /**
   * Coordination (design §5, 2026-11-03): `max_coordination_cost`, `hotspot_paths`, `hotspot_weight`,
   * `mechanical_paths` and `mechanical_weight` (issue #297), `hold_policy` and `hotspot_mode` (issue #314) from
   * factory.config.json, checked at load by
   * `coordinationConfig` and passed in by compose.ts. Absent: DEFAULT_COORDINATION.
   */
  coordination?: CoordinationSettings;
  /**
   * Path companions (design 04-triage.md, issue #224): `path_companions` from factory.config.json, checked at
   * load by `pathCompanionsConfig` (src/core/companions.ts). The triage branch adds each `also` path to an
   * answer's `allowed_paths` when its `files_to_change` names the `when` path. Absent: none.
   */
  path_companions?: PathCompanion[];
  /**
   * The project's toolchain (design 05-sandbox.md, issue #334): `toolchain` from factory.config.json, checked at
   * load by compose.ts (`toolchainConfig`). Absent: no warm step, no readable cache and no extra agent env, so
   * every run is exactly as before the block existed.
   */
  toolchain?: ToolchainConfig;
}

/**
 * The checked `toolchain` block. `caches`: absolute, normalized folders (a leading `~` taken against the owner's
 * HOME) the agent may read and never write; none overlaps a denied path. `env`: non-secret entries added to the
 * agent's environment (G1 checks on key and value). `warm_command`: argv the worker runs before the agent, with
 * the network and no credential; absent in the file: `repo.install_command`.
 */
export interface ToolchainConfig {
  caches: readonly string[];
  env: Readonly<Record<string, string>>;
  warm_command: readonly string[];
}

/** The keys of the `toolchain` block. */
export const TOOLCHAIN_KEYS = ["caches", "env", "warm_command"] as const;

/**
 * Each declared cache that cannot be read safely, with the denied path it overlaps: the cache is that path, lies
 * inside it, or holds it (the secret file's folder is a `deny_paths` entry). One entry per pair; `index` is the
 * cache's place in `caches`. Both lists normalized.
 */
export function toolchainCacheOverlaps(
  caches: readonly string[],
  denied: readonly string[],
): { index: number; cache: string; denied: string }[] {
  return caches.flatMap((cache, index) =>
    denied.filter((d) => isUnder(cache, d) || isUnder(d, cache)).map((d) => ({ index, cache, denied: d })),
  );
}

/** The alarm keys when factory.config.json gives none (design 05-alarms). */
export const ALARM_DEFAULTS = { alarm_repeat_count: 3, alarm_window_minutes: 60, alarm_restart_count: 5 } as const;
/** `agent_stop_checks` when factory.config.json gives none (design §4 Pre-push gates). */
export const AGENT_STOP_CHECKS_DEFAULT = 3;

/** `stall_ms`, `first_output_ms` and `probe_interval_ms` when factory.config.json gives none (design §5 Restarts). */
export const STALL_DEFAULTS = { stall_ms: 300_000, first_output_ms: 180_000, probe_interval_ms: 600_000 } as const;

/** The coordination keys of factory.config.json (design §5, 2026-11-03). */
export const COORDINATION_KEYS = [
  "max_coordination_cost",
  "hotspot_paths",
  "hotspot_weight",
  "mechanical_paths",
  "mechanical_weight",
  "hold_policy",
  "hotspot_mode",
] as const;

/**
 * The coordination settings from the top level of factory.config.json, or why they are invalid. Each key is
 * optional (absent: its default). `max_coordination_cost` and `hotspot_weight` must be numbers above 0; zero,
 * a negative or a non-numeric value fails at startup, like the other numeric keys. `hotspot_paths` is a list of
 * non-empty paths (a folder ends in `/`), and so is `mechanical_paths`. `mechanical_weight` must be a number above
 * 0 and below 1.0 (issue #297): a mechanical path weighs less than any ordinary shared file. `hold_policy` is
 * checked by `parseHoldPolicy`, and `hotspot_mode` is `policy` or `hold` (issue #314).
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
  const mw = r.mechanical_weight;
  if (mw !== undefined && (typeof mw !== "number" || !Number.isFinite(mw) || mw <= 0 || mw >= 1)) {
    problems.push(`mechanical_weight must be a number above 0 and below 1.0 (got ${JSON.stringify(mw) ?? String(mw)})`);
  }
  for (const key of ["hotspot_paths", "mechanical_paths"] as const) {
    const h = r[key];
    if (h !== undefined && (!Array.isArray(h) || !h.every((p) => typeof p === "string" && p.trim() !== ""))) {
      problems.push(`${key} must be a list of non-empty paths`);
    }
  }
  if (r.hold_policy !== undefined) {
    try {
      parseHoldPolicy(r.hold_policy);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (r.hotspot_mode !== undefined && !(HOTSPOT_MODES as readonly unknown[]).includes(r.hotspot_mode)) {
    problems.push(`hotspot_mode must be ${HOTSPOT_MODES.map((m) => `"${m}"`).join(" or ")} (got ${JSON.stringify(r.hotspot_mode) ?? String(r.hotspot_mode)})`);
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
    mechanical: (r.mechanical_paths as string[] | undefined) ?? DEFAULT_COORDINATION.mechanical,
    mechanical_weight: (r.mechanical_weight as number | undefined) ?? DEFAULT_COORDINATION.mechanical_weight,
    hold_policy: r.hold_policy === undefined ? DEFAULT_COORDINATION.hold_policy : parseHoldPolicy(r.hold_policy),
    hotspot_mode: (r.hotspot_mode as HotspotMode | undefined) ?? DEFAULT_COORDINATION.hotspot_mode,
  };
}

/**
 * `cli_user` from the top level of factory.config.json (issue #200): the factory user ID the local CLI
 * commands (`factory task …`, `factory approve …`) act as, e.g. `github:12345`. Never a display name. Absent:
 * null, and every such command fails with an error. A value that is not `<provider>:<id>` throws.
 */
export function cliUserConfig(raw: unknown): UserId | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).cli_user;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[a-z]+:\S+$/.test(v)) {
    throw new Error(`cli_user must be a factory user ID (<provider>:<id>, e.g. github:12345), got ${JSON.stringify(v) ?? String(v)}`);
  }
  return v as UserId;
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
  /** prompts/resolve.md. Absent when the file is missing; a resolve run then fails with `prompt_missing`. */
  resolve?: string;
  /** prompts/improve.md, the improve run's system prompt (design §7). Absent: the improve run asks no model. */
  improve?: string;
}
