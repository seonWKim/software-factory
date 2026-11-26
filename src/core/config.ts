import { type GateEntry, commandText, gateArgv, gateEntryConfig, nonEmptyStrings } from "./checks.js"; export type { GateEntry } from "./checks.js";
import type { PathCompanion } from "./companions.js";
import { type CoordinationSettings, DEFAULT_COORDINATION, type HotspotMode, HOTSPOT_MODES, parseHoldPolicy } from "./coordination.js";
import type { ProjectRef } from "./project.js";
import type { SettingsLayers } from "./settings.js";
import { isUnder, normalize } from "./tools/paths.js";
import type { RunKind, Tier, UserId, VerdictSeverity } from "./types.js";
import type { ToolBroker } from "../interfaces/tool-broker.js";
import agentStopCheck from "../worker/settings/agent-stop-check-ms.setting.js"; import stallMs from "../worker/settings/stall-ms.setting.js";

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
   * against the broker (`toolGrantsConfig`), or the runtime `tool_grants` setting in force (LiveSettings' view, design
   * 08-settings). Absent: no run gets a tool; a kind with no entry gets none either.
   */
  tool_grants?: ToolGrants;
}

/** The run kinds `tool_grants` may name: every kind a worker or the controller records, but `interactive`. */
export const GRANT_RUN_KINDS = ["triage", "implement", "review", "update", "resolve", "manual"] as const satisfies readonly RunKind[];
export type GrantRunKind = (typeof GRANT_RUN_KINDS)[number];

/**
 * A `tool_grants` name for a pack entry (design 11-packs): `pack:tool:<name>` or `pack:mcp_server:<name>`. Not a
 * broker tool, so startup does not check it against the broker; the worker's grant check decides it per run.
 */
export const PACK_GRANT = /^pack:(tool|mcp_server):(\S+)$/;

/** Checked `tool_grants`: read-only broker tool names and pack entry names per run kind. */
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
      if (name.startsWith("pack:")) {
        if (!PACK_GRANT.test(name)) problems.push(`tool_grants.${kind} grants ${JSON.stringify(name)}: a pack entry is pack:tool:<name> or pack:mcp_server:<name>`);
        continue;
      }
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
 * The runtime `tool_grants` setting's value (design 08-settings, 2026-11-13): the same shape as the file key, checked
 * without the broker, which only the worker builds. A name the broker does not list, or one that is not read-only,
 * reaches no agent: the run's tool gate lists and calls only granted read-only tools the broker serves.
 */
export function toolGrantsShape(raw: unknown): ToolGrants {
  const shape = `tool_grants must be an object mapping a run kind (${GRANT_RUN_KINDS.join(", ")}) to a list of tool names`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(shape);
  const out: ToolGrants = {};
  for (const [kind, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!(GRANT_RUN_KINDS as readonly string[]).includes(kind)) throw new Error(`tool_grants key ${JSON.stringify(kind)} is not a run kind; run kinds: ${GRANT_RUN_KINDS.join(", ")}`);
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.trim() !== "")) throw new Error(`tool_grants.${kind} must be a list of tool names`);
    const bad = (names as string[]).find((n) => n.startsWith("pack:") && !PACK_GRANT.test(n));
    if (bad !== undefined) throw new Error(`tool_grants.${kind} grants ${JSON.stringify(bad)}: a pack entry is pack:tool:<name> or pack:mcp_server:<name>`);
    out[kind as GrantRunKind] = [...new Set(names as string[])];
  }
  return out;
}

export const CAPABILITIES_KEYS = ["skill_folders"] as const; // The `capabilities` block's keys (design 08-settings, 2026-11-13).
export { SKILL_IMPROVE_DEFAULTS, SKILL_IMPROVE_KEYS, type SkillImproveConfig, skillImproveConfig, skillImproveProblems } from "./skill-improve-config.js"; // Design 07-self-improvement; folders: capabilities.skill_folders.

/**
 * `capabilities` from factory.config.json: `skill_folders`, the folders whose skills the Settings page lists (a
 * leading `~` is the owner's HOME, a relative path is taken from the config's folder). Absent: none, and nothing
 * fails. A folder that is missing when read lists no skills.
 */
export function capabilitiesConfig(raw: unknown): { skill_folders: readonly string[] } {
  const problems = capabilitiesProblems(raw);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const block = (raw as { capabilities?: { skill_folders?: string[] } } | null)?.capabilities;
  return { skill_folders: block?.skill_folders ?? [] };
}

/** What is wrong with the `capabilities` block, one line each; [] when it is absent or right. */
export function capabilitiesProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const block = (raw as Record<string, unknown>).capabilities;
  if (block === undefined) return [];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return ["capabilities must be an object with skill_folders"];
  const folders = (block as Record<string, unknown>).skill_folders;
  if (folders === undefined) return [];
  if (!Array.isArray(folders) || !folders.every((f) => typeof f === "string" && f.trim() !== "")) return ["capabilities.skill_folders must be a list of folder paths"];
  return [];
}

/** `golden` (design 06-measurement): null (off) when absent; else replays (integer ≥ 1, default 1) and regression_margin (0 to 1, default 0.05); any other value throws, failing startup. */
export function goldenConfig(raw: unknown): { replays: number; regression_margin: number } | null {
  const g = (raw as { golden?: unknown } | null)?.golden, { replays = 1, regression_margin = 0.05 } = (typeof g === "object" && g !== null && !Array.isArray(g) ? g : { replays: g === undefined ? 1 : NaN }) as Record<string, unknown>;
  if (!Number.isInteger(replays) || (replays as number) < 1 || typeof regression_margin !== "number" || !(regression_margin >= 0 && regression_margin <= 1)) throw new Error("golden must be an object whose replays is an integer ≥ 1 (default 1) and whose regression_margin is a number from 0 to 1 (default 0.05)");
  return g === undefined ? null : { replays: replays as number, regression_margin };
}

/** `repo.ui_check`: a gate entry and the path prefixes whose change makes the merge check run it. */
export interface UiCheck {
  command: GateEntry;
  paths: string[];
}

/** The paths a `repo.ui_check` without `paths` watches: the dashboard's sources. */
export const UI_CHECK_DEFAULT_PATHS: readonly string[] = ["web/", "src/ui/"];

/**
 * `repo.ui_check` (design §4, UI check at merge): absent → nothing (off). Otherwise an object with `command`, a gate
 * entry (gateEntryConfig: an argv, or `{ dir, argv }` to run it in a folder), and `paths`, a non-empty list of
 * non-empty path prefixes (absent: UI_CHECK_DEFAULT_PATHS), and no other key; any other value fails startup naming the key.
 */
export function uiCheckConfig(value: unknown): { ui_check?: UiCheck } {
  if (value === undefined) return {};
  const argv = '["npm", "run", "check:responsive"]';
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`repo.ui_check must be an object with a command and optional path prefixes, e.g. { "command": ${argv}, "paths": ["web/", "src/ui/"] }`);
  }
  const { command, paths, ...rest } = value as { command?: unknown; paths?: unknown };
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`repo.ui_check has unknown keys ${extra.join(", ")}; valid keys: command, paths`);
  const entry = gateEntryConfig("repo.ui_check.command", command, argv);
  if (paths !== undefined && !nonEmptyStrings(paths)) {
    throw new Error(`repo.ui_check.paths must be a non-empty list of non-empty path prefixes, e.g. ${JSON.stringify(UI_CHECK_DEFAULT_PATHS)}`);
  }
  return { ui_check: { command: entry, paths: [...(paths ?? UI_CHECK_DEFAULT_PATHS)] } };
}

/** The prompts' `{{ui_check}}` sentence (design §4): with a `repo.ui_check`, it runs at merge and is no missing work; none: "". */
export function uiCheckSentence(ui: UiCheck | undefined): string {
  return ui
    ? ` The project's UI check, \`${commandText(ui.command)}\`, runs at merge, on the merged commit, where a browser can start, never in this sandbox. Not running it here is not work to report as missing or as unverified.`
    : "";
}

/**
 * The implementer's `missing` list without the entries that name the UI check (design §4): it runs at merge on the
 * merged commit, where Chrome can start, so not running it in the sandbox is no missing work. An entry names the check
 * when it holds the command's last argument (e.g. `check:responsive`), in any case. No `repo.ui_check`: all kept.
 */
export function withoutUiCheck(missing: readonly string[], ui: UiCheck | undefined): string[] {
  const name = ui ? gateArgv(ui.command).at(-1)?.toLowerCase() : undefined;
  return name ? missing.filter((m) => !m.toLowerCase().includes(name)) : [...missing];
}

/**
 * The config as loaded from factory.config.json, before startup resolves the configured repo to its project
 * key. `settings.projects` is still keyed by `owner/name` here; the composition root re-keys it.
 */
export interface LoadedConfig {
  /**
   * `install_command` and `test_command`: argv (no shell) of the gate commands. Defaults ["npm", "ci"] and
   * ["npm", "test"]. `install_commands`: gate entries (GateEntry: an argv, or `{ dir, argv }` run in that folder) run in
   * order in place of `install_command` (installStep). `check_commands`: the pre-push checks, gate entries run in order before every push
   * (design §4): the implement run before push (and in its merge-conflict step), the update run on the merged
   * branch, the resolve run after install. Absent: `[test_command]` (checkCommands in src/core/checks.ts).
   * `ui_check`: the UI check (design §4), run only by the merge-check run, after the install command and the checks,
   * on a merged result that changes a path under one of its `paths` prefixes. Absent: off. `restart_command`: argv
   * the restart run runs in the base checkout (design 04-gate-commands, restart); absent: no Restart app, off. `test_selection`: the test files the check before push runs (src/core/test-selection.ts); absent: the full test command. `check_tz`: the IANA zone every merge-check command gets as TZ (checkTzConfig); absent: off. */
  repo: {
    owner: string;
    name: string;
    path: string;
    base_branch: string;
    install_command: string[];
    install_commands?: GateEntry[];
    test_command: string[];
    check_commands?: GateEntry[];
    ui_check?: UiCheck; check_tz?: string; restart_command?: string[]; test_selection?: { hubs: string[]; always: string[] };
  };
  /**
   * True when config selects no forge plugin (design 05-sources, Local startup; set by the composition root from
   * the plugin selection, never a config key): no forge credential, repo lookup or origin fetch, the base is the
   * factory repo's local `refs/heads/<base_branch>`, branches stay local and a human merges with `factory merge`.
   * Absent: a forge plugin is selected, everything as before.
   */
  local_only?: true;
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
  /** Stall detection (design §5 Restarts): a run with no model output this long, no tool call open, ends `stalled`. Absent: STALL_DEFAULTS.stall_ms. */
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
   * `retention` (design 08-retention): days kept per class of operational rows; 0 keeps a class forever. File-only.
   * `raw_records_days` is inbound's raw records (the old top-level `inbox_retention_days`, still read).
   */
  retention: RetentionDays;
  /**
   * `outbound.batching` (RFC 0015 §15.1): each destination kind's batching policy (outbound's BatchingPolicy), `*`
   * for the rest. Empty: `auto`. Parsed by outbound's `batchingPolicies`; core imports no component.
   */
  outbound_batching: Readonly<Record<string, { readonly mode: "auto" | "commit" | "fixed"; readonly debounce_ms: number; readonly max_wait_ms: number; readonly max_messages: number }>>;
  /**
   * `merge_queue.depth` (RFC 0015 §7 Merge queue): how many entries from the head are checked at once, each on the
   * base plus the entries ahead of it. 1 to 10; solo default 1, enterprise typically 2.
   */
  merge_queue_depth: number;
  /**
   * `merge_queue.push_base` (design 05-sources, Local items): with no forge selected, a local merge pushes the local
   * base to the factory repo's origin through the `local` forge. Off (absent) by default; no origin, no push.
   */
  merge_queue_push_base?: boolean;
  /**
   * `hooks` (RFC 0015 §15.2, design 10-event-driven): the hook names the owner enabled, each a discovered
   * `*.hook.ts`. A PR-only key, checked at startup. Absent or empty: no hook runs, solo or enterprise.
   */
  hooks?: readonly string[];
  /**
   * `packs.auto_approve_read_only` (design 11-packs): a read-only pack entry with no credential needs no approval
   * of its own. A PR-only key; absent or false (the default): every pack entry needs the owner's approval.
   */
  packs_auto_approve_read_only?: boolean;
  /** Worker loops in one `dev` or `worker` process (architecture §4). An integer of 0 or more (0: none claims); default 1. */
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
   * `mechanical_paths` and `mechanical_weight` (issue #297), `hold_policy` and `hotspot_mode` (issue #314),
   * `conflict_window_days` (design 05-dependencies) from factory.config.json, checked at load by
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
  /**
   * Read-only input folders (design 05-sandbox.md): `read_only_inputs` from factory.config.json, checked at load by
   * compose.ts (`readOnlyInputsConfig`) with the caches' rules: absolute, normalized, none overlapping a denied
   * path. The agents may read them and never write them. Absent: no input folder, every run as before the key.
   */
  read_only_inputs?: readonly string[];
  improver?: import("./proposals.js").ImproverConfig; // improver.max_proposals, .schedule, distill.min_cases (design 07, improverConfig); absent: IMPROVER_DEFAULTS
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
 * Each read-only folder (a toolchain cache or a read-only input) that cannot be read safely, with the denied path
 * it overlaps: the folder is that path, lies inside it, or holds it (the secret file's folder is a `deny_paths`
 * entry). One entry per pair; `index` is the folder's place in `paths`. Both lists normalized.
 */
export function readOnlyOverlaps(
  paths: readonly string[],
  denied: readonly string[],
): { index: number; path: string; denied: string }[] {
  return paths.flatMap((path, index) =>
    denied.filter((d) => isUnder(path, d) || isUnder(d, path)).map((d) => ({ index, path, denied: d })),
  );
}

/** What a read-only folder list is checked with: the HOME expansion of a configured path, and the denied paths. */
export interface ReadOnlyContext {
  expand: (path: string) => string;
  deny_paths: readonly string[];
}

/**
 * A list of read-only folders (`toolchain.caches`, `read_only_inputs`; design 05-sandbox.md): each an absolute
 * folder after `ctx.expand` (the composition root's leading-`~` expansion to the owner's HOME), normalized, none
 * overlapping a `deny_paths` entry in either direction. Each problem is pushed onto `problems`, naming
 * `key[index]` and, for an overlap, both paths.
 */
export function readOnlyFolders(
  key: string,
  raw: unknown,
  ctx: ReadOnlyContext,
  problems: string[],
): string[] {
  if (!Array.isArray(raw)) {
    problems.push(`${key} must be a list of absolute folders`);
    return [];
  }
  const folders: string[] = [];
  (raw as unknown[]).forEach((c, i) => {
    const expanded = typeof c === "string" ? ctx.expand(c) : c;
    if (typeof expanded !== "string" || !expanded.startsWith("/")) {
      problems.push(`${key}[${i}] must be an absolute folder (or start with ~/), got ${JSON.stringify(c) ?? String(c)}`);
    } else folders.push(normalize(expanded));
  });
  for (const o of readOnlyOverlaps(folders, ctx.deny_paths.map((d) => normalize(d)))) {
    problems.push(`${key}[${o.index}] ${o.path} overlaps the denied path ${o.denied}`);
  }
  return folders;
}

/**
 * `read_only_inputs` from factory.config.json (design 05-sandbox.md): absent → undefined (no input folder).
 * Otherwise the folders the agents may read and never write, with the caches' rules (`readOnlyFolders`). Every
 * problem fails startup at once, one per line.
 */
export function readOnlyInputsConfig(raw: unknown, ctx: ReadOnlyContext): string[] | undefined {
  if (raw === undefined) return undefined;
  const problems: string[] = [];
  const inputs = readOnlyFolders("read_only_inputs", raw, ctx, problems);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return inputs;
}

/**
 * The run spec's read-only fields (design 05-sandbox.md): `readable_paths`, the toolchain caches then the read-only
 * inputs, and the toolchain's `toolchain_env`. Each is left out when nothing configures it.
 */
export function readOnlyRunFields(
  cfg: Pick<LoadedConfig, "toolchain" | "read_only_inputs">,
): { readable_paths?: string[]; toolchain_env?: Readonly<Record<string, string>> } {
  const { toolchain, read_only_inputs: inputs } = cfg;
  return {
    ...(toolchain || inputs ? { readable_paths: [...(toolchain?.caches ?? []), ...(inputs ?? [])] } : {}),
    ...(toolchain ? { toolchain_env: toolchain.env } : {}),
  };
}

/**
 * Days kept per class of operational rows (design 08-retention): the controller's daily pass keeps the first three,
 * inbound's `prune` tick `raw_records_days`.
 */
export interface RetentionDays {
  readonly outbox_days: number;
  readonly commands_days: number;
  readonly records_days: number;
  readonly raw_records_days: number;
}

/** The `retention` defaults: delivered outbox rows and handled commands 30 days, records 90, inbound's raw records 7. */
export const RETENTION_DEFAULTS: RetentionDays = { outbox_days: 30, commands_days: 30, records_days: 90, raw_records_days: 7 };

/** The warning a config with the old top-level key loads with (design 08-retention: deprecated, removal plan there). */
export const INBOX_RETENTION_DEPRECATED = "inbox_retention_days is deprecated: set retention.raw_records_days instead";

/**
 * The `retention` block: each absent key its default; a value that is not an integer of 0 or more fails startup.
 * The old top-level `inbox_retention_days` (a positive integer) still sets raw_records_days when the block does not,
 * with a warning; when both are set the block wins.
 */
export function retentionConfig(raw: unknown, inbox_retention_days?: unknown, warn: (message: string) => void = console.warn): RetentionDays {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) throw new Error("retention must be an object");
  const block = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = { ...RETENTION_DEFAULTS };
  for (const key of Object.keys(RETENTION_DEFAULTS)) {
    const v = block[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`retention.${key} must be an integer of 0 or more (0 keeps forever)`);
    out[key] = v;
  }
  const old = inbox_retention_days;
  if (old !== undefined) {
    if (typeof old !== "number" || !Number.isInteger(old) || old < 1) throw new Error("inbox_retention_days must be a positive integer");
    if (block.raw_records_days === undefined) out.raw_records_days = old;
    warn(block.raw_records_days === undefined ? INBOX_RETENTION_DEPRECATED : `${INBOX_RETENTION_DEPRECATED} (retention.raw_records_days is set and wins)`);
  }
  return out as unknown as RetentionDays;
}

/** The alarm keys when factory.config.json gives none (design 05-alarms). */
export const ALARM_DEFAULTS = { alarm_repeat_count: 3, alarm_window_minutes: 60, alarm_restart_count: 5 } as const;
/** `agent_stop_checks` when factory.config.json gives none (design §4 Pre-push gates). */
export const AGENT_STOP_CHECKS_DEFAULT = 3;
/** The gate Stop check's limit when a run spec gives no `stop_check_ms` (design §4): the setting file's default. */
export const AGENT_STOP_CHECK_MS_DEFAULT = agentStopCheck.default!;

/** `stall_ms` (its setting file's default), `first_output_ms` and `probe_interval_ms` when factory.config.json gives none (design §5 Restarts). */
export const STALL_DEFAULTS = { stall_ms: stallMs.default!, first_output_ms: 180_000, probe_interval_ms: 600_000 } as const;

/** The coordination keys of factory.config.json (design §5, 2026-11-03). */
export const COORDINATION_KEYS = [
  "max_coordination_cost",
  "hotspot_paths",
  "hotspot_weight",
  "mechanical_paths",
  "mechanical_weight",
  "hold_policy",
  "hotspot_mode",
  "conflict_window_days",
] as const;

/**
 * The coordination settings from the top level of factory.config.json, or why they are invalid. Each key is
 * optional (absent: its default). `max_coordination_cost` and `hotspot_weight` must be numbers above 0; zero,
 * a negative or a non-numeric value fails at startup, like the other numeric keys. `hotspot_paths` is a list of
 * non-empty paths (a folder ends in `/`), and so is `mechanical_paths`. `mechanical_weight` must be a number above
 * 0 and below 1.0 (issue #297): a mechanical path weighs less than any ordinary shared file. `hold_policy` is
 * checked by `parseHoldPolicy`, and `hotspot_mode` is `policy` or `hold` (issue #314). `conflict_window_days`
 * (design 05-dependencies) must be a positive integer.
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
  const days = r.conflict_window_days;
  if (days !== undefined && (typeof days !== "number" || !Number.isInteger(days) || days < 1)) {
    problems.push(`conflict_window_days must be a positive integer (got ${JSON.stringify(days) ?? String(days)})`);
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
    conflict_window_days: (r.conflict_window_days as number | undefined) ?? DEFAULT_COORDINATION.conflict_window_days,
  };
}

/**
 * `cli_user` from the top level of factory.config.json (issue #200): the factory user ID the local CLI
 * commands (`factory task …`, `factory approve …`) act as, e.g. `local:<name>`. Never a display name. Absent:
 * null, and every such command fails with an error. A value that is not `<provider>:<id>` throws.
 */
export function cliUserConfig(raw: unknown): UserId | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).cli_user;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[a-z]+:\S+$/.test(v)) {
    throw new Error(`cli_user must be a factory user ID (<provider>:<id>, e.g. local:<name>), got ${JSON.stringify(v) ?? String(v)}`);
  }
  return v as UserId;
}

export interface Prompts {
  triage: string;
  implement: string;
  review: string;
  resolve?: string; // prompts/resolve.md; absent when the file is missing: a resolve run then fails with `prompt_missing`
  "review-confirm"?: string; // prompts/review-confirm.md (design 04-agents); absent: each confirm step fails and its finding stays
  improve?: string; // prompts/improve.md, the improve run's system prompt (design §7); absent: the improve run asks no model
  judge?: string; routine?: string; // prompts/judge.md (design 04-split-specs) and prompts/routine.md; absent: a judge or routine run fails with `prompt_missing` (a goal split then goes on unjudged)
}

/** `merge_queue.push_base` (design 05-sources, Local items): absent means off, otherwise true or false or startup fails. */
export function mergeQueuePushBase(mergeQueue: { push_base?: unknown } | undefined): boolean {
  const v = mergeQueue?.push_base;
  if (v !== undefined && typeof v !== "boolean") throw new Error("merge_queue.push_base must be true or false");
  return v === true;
}
