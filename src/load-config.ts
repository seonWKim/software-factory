// Reading factory.config.json into a Loaded config (moved out of the composition root, RFC 0023 step 2e):
// a test or command that only reads config does not load the wiring in compose.ts.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type FactoryConfig, type LoadedConfig, type Prompts, type StatsConfig, type ToolchainConfig, uiCheckConfig, uiCheckSentence, coordinationConfig,
  mergeQueuePushBase, readOnlyInputsConfig, retentionConfig,
} from "./core/config.js";
import { type ProjectRef, localProjectKey, projectLabel, rekeyProjectSettings } from "./core/project.js";
import { pathCompanionsConfig } from "./core/companions.js";
import { improverConfig } from "./core/proposals.js";
import { checkCommands, commandText } from "./core/checks.js";
import { type SplitLimits, splitThresholds } from "./core/split.js";
import type { Tier } from "./core/types.js";
import { budgetConfig } from "./core/budget.js";
import { type ModelNames, type ModelTable, parseModelBy, parseModels } from "./core/model-choice.js";
import {
  BUILT_IN_SETTINGS, HEARTBEAT_LEASE_MESSAGE, booleanSetting, intakeLabel, maxWorkers, settingValues, settingsLayers, workerCount,
} from "./core/settings.js";
import { checkConfigKeys, removedKeysWarning } from "./config-keys.js";
import { checkStatePaths } from "./state-paths.js";
import { DEFAULT_STATUS_LABEL_PREFIX } from "./interfaces/forge.js";
import { CONFIG_ENV } from "./interfaces/updater.js";
import { updaterConfig } from "./impl/updater/config.js";
import { LOCAL_KEY_FILE } from "./identity/index.js";
import { type PackTool, withPackTools } from "./impl/broker/pack-tools.js";
import type { RepoRef } from "./impl/github/github-client.js";
import type { OpenAICompatibleConfig } from "./impl/openai/config.js";
import type { SlackConfig } from "./impl/source/slack-config.js";
import { defaultSecretsFile } from "./impl/secrets/env-file-secret-store.js";
import { REGISTRY, type Registry, type Selection, selectPlugins, selectedSources, withPackPlugins } from "./plugins.js";
import { batchingPolicies } from "./outbound/index.js";
import { type Pack, autoApproveReadOnly, findPacks, packPluginFiles, packPrompts } from "./packs/packs.js";
import {
  agentStopChecks, alarmConfig, argvConfig, checkCommandsConfig, expandHome, installCommandsConfig, hookNames, isTier, mergeQueueDepth, retryConfig, stallConfig,
  statsConfig, testCommand, toolchainConfig, uiPort, uiUserId,
} from "./config-values.js";
import { testSelectionConfig } from "./core/test-selection.js";

/** The store is SQLite (design 05-coordination.md): another type fails at startup as an unknown FactoryStore plugin. */
export type StoreConfig = { type: "sqlite" };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  /**
   * install_command, test_command: argv, defaults ["npm", "ci"] and ["npm", "test"]. install_commands: a list of gate
   * entries (an argv, or { dir, argv }), the install step in order in place of install_command (installCommandsConfig).
   * check_commands: a list of gate entries, the pre-push checks (design §4); absent: [test_command]. ui_check: the
   * merge-time UI check (uiCheckConfig).
   * check_tz: the merge check's time zone (checkTzConfig).
   * restart_command: argv, the restart run's command (design 04-gate-commands, restart); absent: off. test_selection: testSelectionConfig. */
  repo: {
    owner: string; name: string; path: string; base_branch: string; install_command?: unknown; install_commands?: unknown;
    test_command?: unknown; check_commands?: unknown; ui_check?: unknown; check_tz?: unknown; restart_command?: unknown; test_selection?: unknown };
  intake_label: string;
  /** Prefix of the status labels (docs/plugins.md, SourceAdapter). Absent: "sf: ". */
  status_label_prefix?: string;
  branch_prefix: string;
  dials: { spec_gate_min_tier: number; auto_merge_max_tier: number };
  /** Human floors (design §3). A per-project setting: may move into `defaults`, and a project may add to it. */
  floors?: { prefix: string; tier: number }[];
  /**
   * Removed (design 08-permissions, One owner): no longer read, a config that has it loads with one warning. Typed
   * only for the unselected `static` grant plugin's descriptor, which phase B of issue #575 deletes with this line.
   */
  permissions?: { grants?: unknown; static?: unknown };
  /**
   * Plugin name per interface (docs/plugins.md). Absent: today's defaults. Guards can never be disabled.
   * `source` may be a list of names, one adapter each (design 2026-11-01).
   */
  plugins?: Record<string, unknown>;
  calendar?: unknown; calendar_ids?: unknown; // CalendarSource plugin names, in order, and the calendars a provider reads (docs/plugins/calendar-source.md). Absent or []: none.
  models: { cheap: string; standard: string; strong: string };
  /**
   * Model class per run kind and tier, plus `retry_up` (design §4, 2026-11-02). Absent: DEFAULT_MODEL_BY.
   * Checked by parseModelBy (src/core/model-choice.ts).
   */
  model_by?: unknown;
  max_loops: number;
  /** A split phase's spec counts as approved by the parent's `/approve`. Absent: false. */
  phases_auto_approve?: boolean;
  /** Task failures of one step before it blocks on a human. Per-project setting; absent everywhere: 3. */
  max_attempts?: number;
  /** Infra failures of one step before it blocks on a human. Absent: 3. */
  max_restart?: number;
  /** First automatic retry wait; doubles each retry. Absent: 60000. */
  retry_base_ms?: number;
  /** Cap on a retry wait, and the rate-limit pause with no reset time. Absent: 1800000. */
  retry_max_ms?: number;
  auth_pause_ms?: number; // forge-auth and preflight-access pause (design §5 Restarts). Absent: retry_max_ms.
  /** Pre-push size gate (design §4): added plus deleted lines. Absent: 1500. */
  max_diff_lines?: number;
  /** Pre-push size gate (design §4): changed files. Absent: 40. */
  max_diff_files?: number;
  /** Stall detection (design §5 Restarts): ms of silence that ends an agent run `stalled`. Absent: 300000. */
  stall_ms?: number;
  /** First-output limit (design §5 Restarts): ms with no model output from the start that ends a run `stalled`. Absent: 180000. */
  first_output_ms?: number;
  /** How often a stall pause probes the cheap model. Absent: 600000. */
  probe_interval_ms?: number;
  /** The alarm step's thresholds (design 05-alarms). Settable live. Absent: 3, 60 and 5 (ALARM_DEFAULTS). */
  alarm_repeat_count?: number;
  alarm_window_minutes?: number;
  alarm_restart_count?: number;
  /** The gate hooks' Stop hook (design §4): the most times it sends an implement run's agent back. Absent: 3. */
  agent_stop_checks?: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Deprecated (design 08-retention): `retention.raw_records_days` when that is absent, with a warning. Positive integer. */
  inbox_retention_days?: number;
  retention?: { outbox_days?: unknown; commands_days?: unknown; records_days?: unknown; raw_records_days?: unknown }; // design 08-retention; absent: 30, 30, 90, 7
  /** Outbound (RFC 0015 §15.1): `batching` per destination kind. Absent: `auto` everywhere. */
  outbound?: { batching?: unknown };
  /** The merge queue (RFC 0015 §7): `depth`, the speculative depth (absent: 1); `push_base`, the local forge's base push (absent: off). */
  merge_queue?: { depth?: unknown; push_base?: unknown };
  /** Hook names the owner enabled (RFC 0015 §15.2). Absent: none. Checked against the discovered hooks at startup. */
  hooks?: unknown;
  /** Worker loops per `dev` / `worker` process (architecture §4). Absent: 1. */
  workers?: unknown;
  /** Worker slots per process, the most the live `workers` setting can reach. Absent: `workers`. */
  max_workers?: unknown;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
  /**
   * The status page (`factory ui`). Always bound to 127.0.0.1; there is no host option. `user_id`: the factory
   * user ID the page's commands act as (issue #227); absent, they act as the CLI identity (uiCommandsActor).
   */
  ui?: { port?: number; user_id?: string };
  /** The git-worktree updater (checked by updaterConfig): `auto_migrate` (default false), `code_update_interval_ms` (default 15 min). */
  updater?: { auto_migrate?: unknown; code_update_interval_ms?: unknown };
  /**
   * The GitHub client: `min_remaining` (default 200), the rate-limit floor under which optional reads wait for the
   * reset; `budget_share` (default 1), the part of the hourly core limit this process may count. The GitHub source: `history_since` (absent: none), a date to check merges back to (design §5, Merges).
   */
  github?: { min_remaining?: unknown; budget_share?: unknown; history_since?: unknown };
  /** Token budget per tier, e.g. {"2": 2000000} (design §6). Absent: no limits. Checked by settingsLayers. */
  budgets?: unknown;
  /** Finished items a tier needs before suggestions come from history. Absent: 10. */
  budget_min_sample?: unknown;
  /** `factory stats` (design §6): a weight per verdict severity (all required), min_sample (absent: 10). */
  stats?: { weights?: unknown; min_sample?: unknown };
  /**
   * The global value of each per-project setting (max_attempts, max_diff_lines, max_diff_files, budgets,
   * floors). The same key at top level still works; setting it in both places fails (design 2026-11-01).
   */
  defaults?: unknown;
  /**
   * Overrides per project ID ("owner/name", the configured repo's only; re-keyed to its project key at startup).
   * Per-project keys only, and each may only tighten its gate against the global value. Checked by settingsLayers (src/core/settings.ts).
   */
  projects?: unknown;
  /**
   * Broker tools granted to agent runs: a run kind to a list of tool names, e.g. {"implement": ["forge.preflight"]}.
   * Absent: no grants. Checked at startup against the broker's tools (toolGrantsConfig, src/core/config.ts): only
   * read-only tools the broker lists, only run kinds.
   */
  tool_grants?: unknown;
  /**
   * An OpenAI-style chat completions endpoint (src/impl/openai/config.ts): `base_url` (https, or http only to
   * localhost, 127.0.0.1 or [::1]) and a model name per class. Checked at load; no plugin reads it yet.
   */
  openai_compatible?: OpenAICompatibleConfig;
  /**
   * The `slack` source (issue #109, src/impl/source/slack-config.ts): `channels`, the Slack channel IDs it listens
   * in. Checked at load; required once `plugins.source` lists `slack`, ignored otherwise.
   */
  slack?: SlackConfig;
  /**
   * Path companions (design 04-triage.md): a list of `{ when, also }`. When triage's `files_to_change` names
   * `when`, each `also` path is added to `allowed_paths`. Absent: none. Checked by pathCompanionsConfig.
   */
  path_companions?: unknown;
  /**
   * The project's toolchain (design 05-sandbox.md, issue #334): `caches` (folders the agent may read, never
   * write), `env` (non-secret agent env entries) and `warm_command` (argv the worker runs before the agent, with
   * the network; absent: `repo.install_command`). Absent: none of it. A PR-only key. Checked by toolchainConfig.
   */
  toolchain?: unknown;
  /**
   * Read-only input folders (design 05-sandbox.md): a project's source data outside its repo, which the agents may
   * read and never write, with the toolchain caches' rules. Absent: none. Checked by readOnlyInputsConfig.
   */
  read_only_inputs?: unknown;
  /**
   * Packs (design 11-packs.md): `order`, the layers in order (absent: base, org, project, learned; base first,
   * learned last), `org`, the org pack's folder (absent: no org layer), and `auto_approve_read_only` (absent: false).
   * Checked by packsProblems.
   */
  packs?: { order?: unknown; org?: unknown; auto_approve_read_only?: unknown };
}

/** The checked-in config's name under the code root. */
export const CONFIG_FILE = "factory.config.json";

/**
 * The config path for this process, parsed once at startup for every command: `--config <path>` (or
 * `--config=<path>`) anywhere in `argv`, else FACTORY_CONFIG, made absolute against `cwd`. `args` is `argv`
 * without the flag. No flag and no env var: `configFile` is undefined (the code root's checked-in file).
 */
export function cliConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): { args: string[]; configFile: string | undefined } {
  const args: string[] = [];
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a.startsWith("--config=")) {
      const value = a === "--config" ? argv[++i] : a.slice("--config=".length);
      if (!value) throw new Error("--config needs a path to a factory.config.json");
      flag = value;
    } else args.push(a);
  }
  const chosen = flag ?? (env[CONFIG_ENV] || undefined);
  return { args, configFile: chosen === undefined ? undefined : resolve(cwd, chosen) };
}


/** Reads and parses one config file; a missing, unreadable or invalid file fails naming the path. */
async function readConfigFile(path: string, text?: string): Promise<unknown> {
  try {
    return JSON.parse(text ?? (await readFile(path, "utf8"))) as unknown;
  } catch (err) {
    throw new Error(`cannot load the config file ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export interface Loaded {
  /** The cwd: the main checkout. Repo path resolves here; so do state and worktrees without an external config. */
  root: string;
  /** Where prompts/ (and the checked-in factory.config.json) were read: the runtime copy under the updater, else `root`. */
  codeRoot: string;
  /** The config file that was read, absolute. */
  configFile: string;
  /** The `--config` / FACTORY_CONFIG file, absolute; null when the code root's checked-in file is used. */
  externalConfig: string | null;
  /** `worktrees_dir`, resolved like the state dir. */
  worktreesDir: string;
  file: FileConfig;
  /** Not yet resolved to a project key: build() finds the configured repo's key in the store, or asks GitHub (startupProject). */
  config: LoadedConfig;
  prompts: Prompts;
  secretsFile: string;
  stateDir: string;
  store: StoreConfig;
  /** Checked plugin name per interface. */
  plugins: Selection;
  /** Where plugin names resolve: the built-in REGISTRY (unless a test passes another) plus the packs' plugins. */
  registry: Registry;
  /** The pack layers that are on, in order (design 11-packs.md): where prompts, skills, pack plugins and pack_tools (#592) came from. */
  packs: readonly Pack[];
  pack_tools: readonly PackTool[];
  /** The checked `stats` key. Read only by `factory stats`; no dial uses it. */
  stats: StatsConfig;
  /** The checked `models`: a model name for cheap, standard and strong. */
  models: ModelNames;
  /** The checked, expanded `model_by` (the default table when absent). */
  model_by: ModelTable;
}

/** The placeholder in prompts/*.md that names the project's pre-push checks. */
export const CHECK_COMMANDS_PLACEHOLDER = "{{check_commands}}";
/** The placeholder in prompts/*.md that names where a change lives: the forge plugin, or "local" with none. */
export const FORGE_PLACEHOLDER = "{{forge}}";
export const TOOLCHAIN_PLACEHOLDER = "{{toolchain}}"; // the toolchain sentence (design 05-sandbox.md): empty with no toolchain block
export const UI_CHECK_PLACEHOLDER = "{{ui_check}}"; // the UI check sentence (uiCheckSentence): empty with no repo.ui_check
export const SPLIT_PLACEHOLDERS = ["{{max_diff_lines}}", "{{max_diff_files}}", "{{split_lines}}", "{{split_files}}"] as const;

/**
 * A prompt file's text with its placeholders filled, once at load: the check commands, each command of
 * `checkCommands` (so `repo.check_commands`, else `test_command`) in backticks, in order; the forge name
 * (`plugins.forge`, else "local"); the `toolchain` block's offline sentence; the `repo.ui_check` sentence (none: "");
 * SPLIT_PLACEHOLDERS: the size caps `limits` (the configured project's max_diff_lines, max_diff_files), then their split thresholds.
 */
export function fillPrompt(text: string, repo: FactoryConfig["repo"], forge: string, toolchain?: ToolchainConfig, limits: SplitLimits = BUILT_IN_SETTINGS): string {
  const t = splitThresholds(limits), sizes = [limits.max_diff_lines, limits.max_diff_files, t.lines, t.files];
  const checks = checkCommands(repo).map((c) => `\`${commandText(c)}\``).join(", then ");
  const caches = toolchain && toolchain.caches.length > 0 ? ` (${toolchain.caches.map((c) => `\`${c}\``).join(", ")})` : "";
  const offline = toolchain ? ` They run offline: there is no network, and the toolchain caches${caches} are read-only, so build from what they hold and never write to or download into them.` : "";
  return SPLIT_PLACEHOLDERS.reduce((out, p, i) => out.split(p).join(String(sizes[i])), text).split(CHECK_COMMANDS_PLACEHOLDER).join(checks).split(FORGE_PLACEHOLDER).join(forge).split(TOOLCHAIN_PLACEHOLDER).join(offline).split(UI_CHECK_PLACEHOLDER).join(uiCheckSentence(repo.ui_check));
}

/** The source plugin whose PRs live on GitHub, and the forge it implies (issue #273). */
const GITHUB_SOURCE = "github-issues";
const GITHUB_FORGE = "github";

/**
 * The forge default rule (issue #273): `plugins.forge` left out follows the sources: `github` when `plugins.source`
 * lists github-issues, else none. Derived, not a setting, so a local-only setup makes no GitHub call. An off value
 * next to github-issues fails, naming plugins.forge: that source's PRs would never close their items.
 */
export function withForgeDefault(registry: Registry, selection: Selection, plugins: unknown): Selection {
  if (!selectedSources(selection).includes(GITHUB_SOURCE)) return selection;
  const given = plugins !== null && typeof plugins === "object" && Object.hasOwn(plugins, "forge");
  if (!given) return Object.hasOwn(registry.forge.plugins, GITHUB_FORGE) ? { ...selection, forge: GITHUB_FORGE } : selection;
  if (selection.forge !== undefined) return selection;
  const value = JSON.stringify((plugins as { forge?: unknown }).forge) ?? "nothing";
  throw new Error(
    `plugins.forge is ${value} but plugins.source lists "${GITHUB_SOURCE}": its pull requests (merges, closes, reviews) are read ` +
      `only through a forge, so its factory PRs would never close their items; leave plugins.forge out (it then follows ` +
      `plugins.source) or set it to "${GITHUB_FORGE}"`,
  );
}

/**
 * `codeRoot` is where prompts are read (the updater's runtime copy); `root` is the cwd. `configFile` (from
 * `--config` / FACTORY_CONFIG, see cliConfig) replaces the code root's checked-in factory.config.json, and its
 * folder becomes where `state_dir` and `worktrees_dir` resolve; without it they resolve from `root`.
 * `repo.path` always resolves from `root`. `platform` picks the platform-dependent plugin defaults
 * (docs/plugins.md); the host's unless a test passes one. `text` is read instead of the file (a new text checked before it is written).
 */
export async function loadConfig(
  root = process.cwd(),
  opts: { registry?: Registry; codeRoot?: string | undefined; configFile?: string | undefined; platform?: string | undefined; text?: string } = {},
): Promise<Loaded> {
  const codeRoot = resolve(opts.codeRoot ?? root);
  const checkedIn = join(codeRoot, CONFIG_FILE);
  const externalConfig = opts.configFile === undefined ? null : resolve(root, opts.configFile);
  const configFile = externalConfig ?? checkedIn;
  const raw = await readConfigFile(configFile, opts.text);
  checkConfigKeys(raw);
  const removed = removedKeysWarning(raw);
  if (removed !== null) console.warn(removed);
  const file = raw as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error(
      "dials.auto_merge_max_tier must be 0: the auto-merge tier is the live auto_merge_max_tier setting (0 to 3, " +
        "`factory settings set auto_merge_max_tier <n>` or the Settings page, with approve_merge), read only in auto mode",
    );
  }
  if (!isTier(file.dials.spec_gate_min_tier)) throw new Error("tiers must be integers 1–5");
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error(HEARTBEAT_LEASE_MESSAGE);
  uiPort(file.ui);
  uiUserId(file.ui);
  updaterConfig(file.updater);
  const workers = workerCount(file.workers);
  const max_workers = maxWorkers(workers, file.max_workers);
  const retry = retryConfig(file);
  // The per-project gate settings in layers (design 2026-11-01): top level / `defaults`, then `projects`.
  const settings = settingsLayers(raw as Record<string, unknown>, `${file.repo.owner}/${file.repo.name}`);
  const retention = { retention: retentionConfig(file.retention, file.inbox_retention_days) };
  const budget = budgetConfig({ budget_min_sample: file.budget_min_sample });
  const stats = statsConfig(file.stats);
  const models = parseModels(file.models);
  const model_by = parseModelBy(file.model_by);
  const store = file.store ?? { type: "sqlite" };
  const stateBase = externalConfig === null ? root : dirname(externalConfig);
  const stateDir = resolve(stateBase, file.state_dir);
  const worktreesDir = resolve(stateBase, file.worktrees_dir);
  const repoPath = resolve(root, file.repo.path);
  // The pack layers (design 11-packs.md): base (the code root), org (`packs.org`), project (`.factory/` in the
  // repo's main checkout) and learned (under the state dir). A missing layer is off. Their plugins and tools join a registry copy.
  const packs = findPacks({ codeRoot, repoPath, stateDir, configDir: stateBase, packs: file.packs });
  const packRegistry = await withPackPlugins(opts.registry ?? REGISTRY, packPluginFiles(packs));
  const plugins = withForgeDefault(packRegistry, selectPlugins(packRegistry, { store, calendar: file.calendar, plugins: file.plugins }, { platform: opts.platform }), file.plugins);
  const { registry, pack_tools } = await withPackTools(packRegistry, plugins.broker, packs, opts.registry ?? REGISTRY);
  const local = !selectsGitHub(plugins);
  if (!local) await checkGitHubSettings(file.github);
  const secretsFile = defaultSecretsFile();

  const home = process.env.HOME ?? "";
  const { install_commands: rawInstalls, check_commands: rawChecks, ui_check: rawUiCheck, check_tz: rawTz, restart_command: rawRestart, test_selection: rawSelection, ...fileRepo } = file.repo;
  const test_command = testCommand(file.repo.test_command);
  const config: LoadedConfig = {
    repo: {
      ...fileRepo,
      path: repoPath,
      install_command: argvConfig("repo.install_command", file.repo.install_command, ["npm", "ci"]),
      test_command,
      ...installCommandsConfig(rawInstalls), ...checkCommandsConfig(rawChecks), ...uiCheckConfig(rawUiCheck), ...checkTzConfig(rawTz), ...testSelectionConfig(rawSelection, test_command), ...(rawRestart === undefined ? {} : { restart_command: argvConfig("repo.restart_command", rawRestart, ["bin/restart"]) }),
    },
    ...(local ? { local_only: true as const } : {}),
    intake_label: intakeLabel(file.intake_label),
    status_label_prefix: file.status_label_prefix ?? DEFAULT_STATUS_LABEL_PREFIX,
    branch_prefix: file.branch_prefix,
    dials: { spec_gate_min_tier: file.dials.spec_gate_min_tier as Tier, auto_merge_max_tier: 0 },
    settings,
    max_loops: file.max_loops,
    phases_auto_approve: file.phases_auto_approve === undefined ? false : booleanSetting("phases_auto_approve", file.phases_auto_approve),
    ...retry, // max_restart, retry_base_ms, retry_max_ms, auth_pause_ms
    lease_ms: file.lease_ms,
    heartbeat_ms: file.heartbeat_ms,
    tick_ms: file.tick_ms,
    poll_interval_ms: file.poll_interval_ms,
    run_timeout_ms: file.run_timeout_ms,
    ...stallConfig(file),
    ...alarmConfig(file),
    agent_stop_checks: agentStopChecks(file),
    ...retention, // the retention block, inbox_retention_days as its fallback (design 08-retention)
    outbound_batching: batchingPolicies(file.outbound?.batching),
    merge_queue_depth: mergeQueueDepth(file), merge_queue_push_base: mergeQueuePushBase(file.merge_queue),
    ...(file.hooks === undefined ? {} : { hooks: hookNames(file.hooks) }),
    ...(autoApproveReadOnly(file.packs) ? { packs_auto_approve_read_only: true } : {}),
    workers,
    max_workers,
    deny_paths: [
      dirname(secretsFile),
      join(stateDir, "db"),
      join(stateDir, "storage"),
      // The owner's test MySQL login (SET_UP.md): agents may connect to localhost since the sandbox allows it.
      join(stateDir, "test-mysql.url"),
      // The solo passport key (Identity): an agent that read it could mint passports.
      join(stateDir, LOCAL_KEY_FILE),
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".config", "gh"),
      join(home, ".claude"),
      join(home, ".gitconfig"),
      join(home, ".git-credentials"),
      join(home, ".netrc"),
      join(home, ".my.cnf"),
      join(home, ".mylogin.cnf"),
      // GnuPG keys (RFC 0024 WP2 step A).
      join(home, ".gnupg"),
      // The desktop app's profile: its Chromium session may hold dashboard cookies a run could use to act as the owner.
      // A plain home path: on a host without it (not macOS, no desktop app) the entry denies nothing.
      join(home, "Library", "Application Support", "software-factory"),
    ],
    agent_git_identity: file.agent_git_identity,
    budget_min_sample: budget.budget_min_sample,
    path_companions: pathCompanionsConfig(raw),
    improver: improverConfig(raw), // improver.max_proposals, improver.schedule, distill.min_cases (design 07)
    // Coordination (design §5): the threshold, hotspots and mechanical paths, checked at load by checkConfigKeys.
    coordination: coordinationConfig(raw),
  };
  if (externalConfig !== null) checkStatePaths({ state_dir: stateDir, worktrees_dir: worktreesDir }, config.deny_paths);
  // The toolchain block (design 05-sandbox.md): its caches checked against every denied path, the secret folder included.
  const toolchain = toolchainConfig(file.toolchain, { home, install_command: config.repo.install_command, deny_paths: config.deny_paths });
  if (toolchain) config.toolchain = toolchain;
  const inputs = readOnlyInputsConfig(file.read_only_inputs, { expand: expandHome(home), deny_paths: config.deny_paths });
  if (inputs) config.read_only_inputs = inputs;
  // Each prompt through the pack layers, placeholders filled after the merge (design 11-packs.md). A required
  // prompt no layer has fails startup; owner-defaults is appended to triage.
  const prompts = await packPrompts(packs, (text) => fillPrompt(text, config.repo, plugins.forge ?? "local", config.toolchain, settingValues(`${file.repo.owner}/${file.repo.name}`, settings)));
  return { root, codeRoot, configFile, externalConfig, worktreesDir, file, config, prompts, secretsFile, stateDir, store, plugins, registry, packs, pack_tools, stats, models, model_by };
}

/**
 * The plugins that call GitHub, per interface (design 05-sources, Local startup). The `github_auth` credentials are
 * not on the list: they are read only for a plugin that is.
 */
const GITHUB_PLUGINS: Readonly<Partial<Record<keyof Selection, readonly string[]>>> = {
  broker: ["github"], forge: ["github"],
};
const GITHUB_SOURCES: readonly string[] = ["github-issues"];

/**
 * Whether config selects any GitHub plugin: a GitHub source, broker or forge. The one rule for the local path
 * (`local_only`): none selected means no GitHub credential, repo lookup, origin fetch or PR, whether or not the factory repo has a remote.
 */
export function selectsGitHub(sel: Selection): boolean {
  if (selectedSources(sel).some((s) => GITHUB_SOURCES.includes(s))) return true;
  return Object.entries(GITHUB_PLUGINS).some(([kind, names]) => {
    const name = sel[kind as keyof Selection];
    return typeof name === "string" && names!.includes(name);
  });
}

/**
 * GitHub's settings (`github` in factory.config.json), checked at load only when a GitHub plugin is selected: a
 * config with none loads no GitHub implementation module.
 */
async function checkGitHubSettings(github: FileConfig["github"]): Promise<void> {
  const [client, issues] = await Promise.all([import("./impl/github/github-client.js"), import("./impl/github/github-issue-source.js")]);
  client.githubMinRemaining(github);
  client.githubBudgetShare(github);
  issues.githubHistorySince(github);
}

/**
 * `repo.check_tz` (design §4, the merge check's time zone): absent → nothing (off, the machine's zone). Otherwise an
 * IANA zone name (e.g. "UTC", "Asia/Seoul") that every merge-check command gets as TZ; any other value, an offset
 * such as "+09:00" included, fails startup naming the key.
 */
function checkTzConfig(value: unknown): { check_tz?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[A-Za-z]/.test(value) || !knownZone(value)) {
    throw new Error(`repo.check_tz must be an IANA time zone name, e.g. "UTC" or "Asia/Seoul"; got ${JSON.stringify(value)}`);
  }
  return { check_tz: value };
}

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The configured repo as a local project: `local:local:<sha-256 of owner/name>`, labelled `local/owner/name`. */
export function localProject(repo: RepoRef): ProjectRef {
  const digest = createHash("sha256").update(`${repo.owner}/${repo.name}`).digest("hex").slice(0, 32);
  return { key: localProjectKey(digest), label: projectLabel("local", repo.owner, repo.name) };
}

/** The loaded config with the resolved project, and the per-project settings re-keyed from `owner/name` to its key. */
export function resolvedConfig(config: LoadedConfig, project: ProjectRef): FactoryConfig {
  const ownerName = `${config.repo.owner}/${config.repo.name}`;
  return { ...config, project, settings: { ...config.settings, projects: rekeyProjectSettings(config.settings.projects, ownerName, project.key) } };
}
