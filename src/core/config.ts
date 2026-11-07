import type { PathCompanion } from "./companions.js";
import { type CoordinationSettings, DEFAULT_COORDINATION } from "./coordination.js";
import type { ProjectRef } from "./project.js";
import type { SettingsLayers } from "./settings.js";
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
   * Coordination (design §5, 2026-11-03): `max_coordination_cost`, `hotspot_paths`, `hotspot_weight` from
   * factory.config.json, checked at load by `coordinationConfig`. Absent: DEFAULT_COORDINATION.
   */
  coordination?: CoordinationSettings;
  /**
   * Path companions (design 04-triage.md, issue #224): `path_companions` from factory.config.json, checked at
   * load by `pathCompanionsConfig` (src/core/companions.ts). The triage branch adds each `also` path to an
   * answer's `allowed_paths` when its `files_to_change` names the `when` path. Absent: none.
   */
  path_companions?: PathCompanion[];
}

/** `stall_ms`, `first_output_ms` and `probe_interval_ms` when factory.config.json gives none (design §5 Restarts). */
export const STALL_DEFAULTS = { stall_ms: 300_000, first_output_ms: 180_000, probe_interval_ms: 600_000 } as const;

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

/** Keys of the `slack` block of factory.config.json (docs/plugins/source-adapter.md, `slack`). */
export const SLACK_KEYS = ["channels"] as const;

/** The checked `slack` block: the channel IDs the slack source listens in. IDs only, never channel names. */
export interface SlackConfig {
  channels: readonly string[];
}

/** A Slack channel ID: `C…` (public) or `G…` (private), upper-case letters and digits. */
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

/**
 * Why the `slack` block is invalid, checked at load whether or not the slack source is selected. Absent: no
 * problem. Otherwise an object whose only key is `channels`, a non-empty list of distinct channel IDs.
 */
export function slackProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const block = (raw as Record<string, unknown>).slack;
  if (block === undefined) return [];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return ["slack must be an object with `channels`, a list of Slack channel IDs"];
  }
  const problems: string[] = [];
  for (const key of Object.keys(block)) {
    if (!(SLACK_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown config key "${key}" at slack.${key}; valid slack keys: ${SLACK_KEYS.join(", ")}`);
    }
  }
  const ch = (block as Record<string, unknown>).channels;
  if (!Array.isArray(ch) || ch.length === 0 || !ch.every((c) => typeof c === "string" && SLACK_CHANNEL_ID.test(c))) {
    problems.push("slack.channels must be a non-empty list of Slack channel IDs (e.g. \"C0123ABCD\"), never channel names");
  } else if (new Set(ch).size !== ch.length) {
    problems.push("slack.channels lists a channel twice; name each channel once");
  }
  return problems;
}

/** The checked `slack` block; throws when it is absent or invalid (the slack source cannot run without it). */
export function slackConfig(raw: unknown): SlackConfig {
  const problems = slackProblems(raw);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const block = (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).slack : undefined) as
    | { channels: string[] }
    | undefined;
  if (block === undefined) throw new Error("the slack source needs a `slack` block in factory.config.json with `channels`, a list of channel IDs");
  return { channels: [...block.channels] };
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
}
