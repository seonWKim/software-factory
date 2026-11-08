// Composition root: the only place that reads env/files for config and picks implementations.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { availableParallelism, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_STOP_CHECKS_DEFAULT, ALARM_DEFAULTS, type FactoryConfig, type LoadedConfig, type Prompts, STALL_DEFAULTS, type StatsConfig, type ToolchainConfig, cliUserConfig,
  coordinationConfig, toolGrantsConfig, toolchainCacheOverlaps,
} from "./core/config.js";
import { toolchainEnvKeyRefusal } from "./core/tools/policy.js";
import { type ProjectRef, githubProjectKey, localProjectKey, projectLabel, rekeyProjectSettings } from "./core/project.js";
import { pathCompanionsConfig } from "./core/companions.js";
import { checkCommands, commandText } from "./core/checks.js";
import { saveProject, saveProjectLabel } from "./core/project-labels.js";
import type { Logger } from "./core/log.js";
import type { CliIdentity } from "./core/local-cli.js";
import type { Tier, UserId, VerdictSeverity } from "./core/types.js";
import { budgetConfig } from "./core/budget.js";
import { type ModelNames, type ModelTable, parseModelBy, parseModels } from "./core/model-choice.js";
import { gitHost, hostId } from "./runtime/host-id.js";
import { ControllerRole } from "./runtime/roles/controller-role.js";
import { loadHooks } from "./runtime/index.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";
import {
  type GlobalSettableKey, HEARTBEAT_LEASE_MESSAGE, booleanSetting, LiveSettings, SETTABLE_KEYS, type SettingsBase, isProjectSettableKey, maxWorkers, positiveInteger, settingsLayers, workerCount,
} from "./core/settings.js";
import { WorkerPool } from "./worker/index.js";
import type { LocalRoute } from "./worker/index.js";
import { FallbackLLM } from "./core/fallback-llm.js";
import { FallbackRunner } from "./core/fallback-runner.js";
import { checkConfigKeys } from "./config-keys.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubAccess, GitHubApi, GitHubCredentials, RepoIdentity } from "./interfaces/github-credentials.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Forge } from "./interfaces/forge.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { AuthAction, AuthDecision, AuthProvider } from "./interfaces/auth-provider.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { CODE_VERSION_ENV, CONFIG_ENV, type ChildRestart, SUPERVISOR_STATUS_FILE, type SupervisorStatus, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";
import { autoMigrate } from "./impl/updater/auto-migrate.js";
import { LOCAL_KEY_FILE, ProfileStore, startIdentity, type IdentityRuntime } from "./identity/index.js";
import { AuditedAuthProvider, PluginIdentityProvider, controllerServiceAuth, outboundServiceAuth } from "./impl/auth/audited-auth.js";
import { PassportToolBroker } from "./impl/broker/passport-broker.js";
import { storeSql } from "./impl/store/sql/store-sql.js";
import { RunPassports } from "./worker/passports/run-passports.js";
import { GitHubError, type RepoRef, githubBudgetShare, githubMinRemaining } from "./impl/github/github-client.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import type { UiCommands } from "./ui/commands.js";
import { BIND as UI_BIND } from "./ui/server.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "./ui/settings-api.js";
import type { UiPauses } from "./ui/pause-api.js";
import type { OpenAICompatibleConfig } from "./impl/openai/config.js";
import type { SlackConfig } from "./impl/source/slack-config.js";
import { baseEnv } from "./impl/process/run-process.js";
import { DEFAULT_STATUS_LABEL_PREFIX, githubHistorySince } from "./impl/github/github-issue-source.js";
import { defaultSecretsFile, readEnvSettings } from "./impl/secrets/env-file-secret-store.js";
import {
  type BaseContext, GRANTS, REGISTRY, type Registry, type Selection, createGrants, createPlugin, selectGrants, selectPlugins, selectedLlms, selectedLocalAuth, selectedRunners, selectedSources,
} from "./plugins.js";
import { batchingPolicies } from "./outbound/index.js";

/** SQLite: one machine. MySQL: any number of controllers and workers on any hosts (architecture §4). */
export type StoreConfig =
  | { type: "sqlite" }
  | { type: "mysql"; host: string; port: number; database: string; user: string };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  /**
   * install_command, test_command: argv, defaults ["npm", "ci"] and ["npm", "test"]. check_commands: a list of
   * argv, the pre-push checks (design §4); absent: [test_command].
   */
  repo: {
    owner: string; name: string; path: string; base_branch: string;
    install_command?: unknown; test_command?: unknown; check_commands?: unknown;
  };
  intake_label: string;
  /** Prefix of the status labels (docs/plugins.md, SourceAdapter). Absent: "sf: ". */
  status_label_prefix?: string;
  branch_prefix: string;
  dials: { spec_gate_min_tier: number; auto_merge_max_tier: number };
  /** Human floors (design §3). A per-project setting: may move into `defaults`, and a project may add to it. */
  floors?: { prefix: string; tier: number }[];
  /**
   * AuthProvider plugin name (docs/plugins.md) for GitHub comments, or one per command origin (issue #318):
   * `{ "github_issue": "github", "local": "local" }`. Local commands use `local` unless `auth.local` says otherwise.
   */
  auth: unknown;
  /**
   * Who may act (design 2026-11-01): `grants`, the grant plugins whose union decides (absent: github-permission),
   * and grant settings such as `static` (docs/plugins.md, GrantSource). Checked by selectGrants and each grant.
   */
  permissions?: { grants?: unknown; static?: unknown };
  /**
   * Plugin name per interface (docs/plugins.md). Absent: today's defaults. Guards can never be disabled.
   * `source` may be a list of names, one adapter each (design 2026-11-01).
   */
  plugins?: Record<string, unknown>;
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
  /** Stream intake: days an inbox row is kept once behind its cursor. Absent: 14. Positive integer. */
  inbox_retention_days?: number;
  /** Outbound (RFC 0015 §15.1): `batching` per destination kind. Absent: `auto` everywhere. */
  outbound?: { batching?: unknown };
  /** The merge queue (RFC 0015 §7): `depth`, the speculative depth. Absent: 1. */
  merge_queue?: { depth?: unknown };
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
  /** The git-worktree updater: `auto_migrate` (default false) runs `npm run migrate` itself between drain and start. */
  updater?: { auto_migrate?: unknown };
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
   * Per-project keys only, and each may only tighten its gate against the global value. Checked by
   * settingsLayers (src/core/settings.ts).
   */
  projects?: unknown;
  /**
   * Broker tools granted to agent runs: a run kind to a list of tool names, e.g. {"triage": ["github.preflight"]}.
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
}

export { CODE_ROOT_ENV, CONFIG_ENV, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";

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

/**
 * Keys a reviewed PR sets (floors, dials, plugins, permissions, auth, and `toolchain`: what agents may read and
 * the env they get). On a shared store (MySQL: the enterprise case) they come only from the checked-in file, so a
 * user's own config cannot loosen them; solo use may set any key.
 */
const REVIEWED_KEYS = ["dials", "floors", "plugins", "permissions", "auth", "toolchain"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads and parses one config file; a missing, unreadable or invalid file fails naming the path. */
async function readConfigFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`cannot load the config file ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** An external config on a shared store, with REVIEWED_KEYS (and `defaults.floors`) taken from the checked-in file. */
async function withReviewedKeys(raw: unknown, checkedIn: string): Promise<unknown> {
  if (!isRecord(raw) || !isRecord(raw.store) || raw.store.type !== "mysql") return raw;
  const reviewed = await readConfigFile(checkedIn);
  if (!isRecord(reviewed)) return raw; // checkConfigKeys reports the external file's own shape
  const out: Record<string, unknown> = { ...raw };
  const take = (to: Record<string, unknown>, from: Record<string, unknown>, k: string) => {
    if (k in from) to[k] = from[k];
    else delete to[k];
  };
  for (const k of REVIEWED_KEYS) take(out, reviewed, k);
  if (isRecord(out.defaults) || isRecord(reviewed.defaults)) {
    const defaults = { ...(isRecord(out.defaults) ? out.defaults : {}) };
    take(defaults, isRecord(reviewed.defaults) ? reviewed.defaults : {}, "floors");
    out.defaults = defaults;
  }
  return out;
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
  /** Where plugin names resolve. The built-in REGISTRY unless a test passes another. */
  registry: Registry;
  /** The checked `permissions.grants`: grant plugin names, in config order. */
  grants: readonly string[];
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

/** The placeholder in prompts/*.md for the toolchain sentence (design 05-sandbox.md): empty with no toolchain block. */
export const TOOLCHAIN_PLACEHOLDER = "{{toolchain}}";

/**
 * A prompt file's text with its placeholders filled, once at load: the check commands, each command of
 * `checkCommands` (so `repo.check_commands`, else `test_command`) in backticks, in order; the forge name
 * (`plugins.forge`, else "local"); and with a `toolchain` block, one sentence saying those checks run offline from
 * the read-only caches. No block: the toolchain placeholder is removed, so the text is what it was before the block existed.
 */
export function fillPrompt(text: string, repo: FactoryConfig["repo"], forge: string, toolchain?: ToolchainConfig): string {
  const checks = checkCommands(repo).map((c) => `\`${commandText(c)}\``).join(", then ");
  const caches = toolchain && toolchain.caches.length > 0 ? ` (${toolchain.caches.map((c) => `\`${c}\``).join(", ")})` : "";
  const offline = toolchain
    ? ` They run offline: there is no network, and the toolchain caches${caches} are read-only, so build from what they hold and never write to or download into them.`
    : "";
  return text.split(CHECK_COMMANDS_PLACEHOLDER).join(checks).split(FORGE_PLACEHOLDER).join(forge).split(TOOLCHAIN_PLACEHOLDER).join(offline);
}

/** The source plugin whose PRs live on GitHub, and the forge it implies (issue #273). */
const GITHUB_SOURCE = "github-issues";
const GITHUB_FORGE = "github";
/** The broker plugin local items always take (Plugins.localRoute). */
const LOCAL_BROKER = "local";

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
 * (docs/plugins.md); the host's unless a test passes one.
 */
export async function loadConfig(
  root = process.cwd(),
  opts: { registry?: Registry; codeRoot?: string | undefined; configFile?: string | undefined; platform?: string | undefined } = {},
): Promise<Loaded> {
  const codeRoot = resolve(opts.codeRoot ?? root);
  const checkedIn = join(codeRoot, CONFIG_FILE);
  const externalConfig = opts.configFile === undefined ? null : resolve(root, opts.configFile);
  const configFile = externalConfig ?? checkedIn;
  const raw = externalConfig === null ? await readConfigFile(checkedIn) : await withReviewedKeys(await readConfigFile(externalConfig), checkedIn);
  checkConfigKeys(raw);
  const file = raw as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error(
      "dials.auto_merge_max_tier must be 0: the auto-merge tier is the live auto_merge_max_tier setting (0 to 3, " +
        "`factory settings set auto_merge_max_tier <n>` or the Settings page, with approve_merge), read only in auto mode",
    );
  }
  if (!isTier(file.dials.spec_gate_min_tier)) {
    throw new Error("tiers must be integers 1–5");
  }
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error(HEARTBEAT_LEASE_MESSAGE);
  uiPort(file.ui);
  uiUserId(file.ui);
  autoMigrate(file.updater);
  githubMinRemaining(file.github);
  githubBudgetShare(file.github);
  githubHistorySince(file.github);
  const workers = workerCount(file.workers);
  const max_workers = maxWorkers(workers, file.max_workers);
  const retry = retryConfig(file);
  // The per-project gate settings in layers (design 2026-11-01): top level / `defaults`, then `projects`.
  const settings = settingsLayers(raw as Record<string, unknown>, `${file.repo.owner}/${file.repo.name}`);
  const retention = inboxRetentionDays(file);
  const budget = budgetConfig({ budget_min_sample: file.budget_min_sample });
  const stats = statsConfig(file.stats);
  const models = parseModels(file.models);
  const model_by = parseModelBy(file.model_by);
  const registry = opts.registry ?? REGISTRY;
  const baseStore = file.store ?? { type: "sqlite" };
  const plugins = withForgeDefault(
    registry, selectPlugins(registry, { store: baseStore, auth: file.auth, plugins: file.plugins }, { platform: opts.platform }), file.plugins,
  );
  const grants = selectGrants(GRANTS, file.permissions);
  const local = !selectsGitHub(plugins, grants);
  const secretsFile = defaultSecretsFile();
  const store = await storeConfig(baseStore, secretsFile);

  const stateBase = externalConfig === null ? root : dirname(externalConfig);
  const stateDir = resolve(stateBase, file.state_dir);
  const worktreesDir = resolve(stateBase, file.worktrees_dir);
  const home = process.env.HOME ?? "";
  const { check_commands: rawChecks, ...fileRepo } = file.repo;
  const config: LoadedConfig = {
    repo: {
      ...fileRepo,
      path: resolve(root, file.repo.path),
      install_command: argvConfig("repo.install_command", file.repo.install_command, ["npm", "ci"]),
      test_command: testCommand(file.repo.test_command),
      ...checkCommandsConfig(rawChecks),
    },
    ...(local ? { local_only: true as const } : {}),
    intake_label: file.intake_label,
    status_label_prefix: file.status_label_prefix ?? DEFAULT_STATUS_LABEL_PREFIX,
    branch_prefix: file.branch_prefix,
    dials: { spec_gate_min_tier: file.dials.spec_gate_min_tier as Tier, auto_merge_max_tier: 0 },
    settings,
    max_loops: file.max_loops,
    phases_auto_approve: file.phases_auto_approve === undefined ? false : booleanSetting("phases_auto_approve", file.phases_auto_approve),
    max_restart: retry.max_restart,
    retry_base_ms: retry.retry_base_ms,
    retry_max_ms: retry.retry_max_ms,
    lease_ms: file.lease_ms,
    heartbeat_ms: file.heartbeat_ms,
    tick_ms: file.tick_ms,
    poll_interval_ms: file.poll_interval_ms,
    run_timeout_ms: file.run_timeout_ms,
    ...stallConfig(file),
    ...alarmConfig(file),
    agent_stop_checks: agentStopChecks(file),
    inbox_retention_days: retention,
    outbound_batching: batchingPolicies(file.outbound?.batching),
    merge_queue_depth: mergeQueueDepth(file),
    ...(file.hooks === undefined ? {} : { hooks: hookNames(file.hooks) }),
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
    ],
    agent_git_identity: file.agent_git_identity,
    budget_min_sample: budget.budget_min_sample,
    path_companions: pathCompanionsConfig(raw),
    // Coordination (design §5): the threshold, hotspots and mechanical paths, checked at load by checkConfigKeys.
    coordination: coordinationConfig(raw),
  };
  // The toolchain block (design 05-sandbox.md): its caches checked against every denied path, the secret folder included.
  const toolchain = toolchainConfig(file.toolchain, { home, install_command: config.repo.install_command, deny_paths: config.deny_paths });
  if (toolchain) config.toolchain = toolchain;
  const readPrompt = async (name: string): Promise<string> => fillPrompt(await readFile(join(codeRoot, "prompts", `${name}.md`), "utf8"), config.repo, plugins.forge ?? "local", config.toolchain);
  const prompts: Prompts = {
    triage: await readPrompt("triage"),
    implement: await readPrompt("implement"),
    review: await readPrompt("review"),
  };
  // Optional prompt files: a missing one is not an error (resolve: `prompt_missing`; improve: no drafts).
  const optional = (name: string) =>
    readPrompt(name).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
  for (const name of ["resolve", "improve"] as const) {
    const text = await optional(name);
    if (text !== undefined) prompts[name] = text;
  }
  // The owner's standing answers (design 04-triage.md, issue #315), appended so triage applies them instead of asking.
  const ownerDefaults = await optional("owner-defaults");
  if (ownerDefaults !== undefined) prompts.triage = `${prompts.triage.trimEnd()}\n\n${ownerDefaults}`;
  return { root, codeRoot, configFile, externalConfig, worktreesDir, file, config, prompts, secretsFile, stateDir, store, plugins, registry, grants, stats, models, model_by };
}

/**
 * The plugins that call GitHub, per interface, and the grants that do (design 05-sources, Local startup). The
 * `github_auth` credentials are not on the list: they are read only for a plugin that is.
 */
const GITHUB_PLUGINS: Readonly<Partial<Record<keyof Selection, readonly string[]>>> = {
  auth: ["github"], local_auth: ["github"], broker: ["github"], forge: ["github"],
};
const GITHUB_SOURCES: readonly string[] = ["github-issues"];
const GITHUB_GRANTS: readonly string[] = ["github-permission"];

/**
 * Whether config selects any GitHub plugin: a GitHub source, auth, broker, forge or grant. The one rule for the
 * local path (`local_only`): none selected means no GitHub credential, repo lookup, origin fetch or PR, whether
 * or not the factory repo has a remote.
 */
export function selectsGitHub(sel: Selection, grants: readonly string[]): boolean {
  if (selectedSources(sel).some((s) => GITHUB_SOURCES.includes(s))) return true;
  if (grants.some((g) => GITHUB_GRANTS.includes(g))) return true;
  return Object.entries(GITHUB_PLUGINS).some(([kind, names]) => {
    const name = sel[kind as keyof Selection];
    return typeof name === "string" && names!.includes(name);
  });
}

/** The configured repo as a local project: `local:local:<sha-256 of owner/name>`, labelled `local/owner/name`. */
export function localProject(repo: RepoRef): ProjectRef {
  const digest = createHash("sha256").update(`${repo.owner}/${repo.name}`).digest("hex").slice(0, 32);
  return { key: localProjectKey(digest), label: projectLabel("local", repo.owner, repo.name) };
}

/** What startup resolution needs from the GitHub client: one read of the repository. */
export interface RepoLookup {
  repoIdentity(repo: RepoRef): Promise<RepoIdentity>;
}

/**
 * The configured repo as a project (design 2026-11-01): its key from GitHub's node ID, its label from the path
 * GitHub reports now (a renamed repo gets its new path). Throws a message naming the configured repo and the
 * reason (the GitHub error as its `cause`) when GitHub cannot resolve it; startupProject decides what a start does then.
 */
export async function resolveProject(github: RepoLookup, repo: RepoRef): Promise<ProjectRef> {
  try {
    const id = await github.repoIdentity(repo);
    return { key: githubProjectKey(id.host, id.node_id), label: projectLabel(id.host, id.owner, id.name) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot resolve the configured repo ${repo.owner}/${repo.name} (factory.config.json repo.owner / repo.name) to its GitHub repository ID: ${reason}`,
      { cause: err },
    );
  }
}

/** First wait between startup lookups while the configured repo's key is not known yet; it doubles up to the max. */
export const PROJECT_RETRY_MS = 30_000;
const PROJECT_RETRY_MAX_MS = 600_000;

/** A lookup error retrying cannot fix: bad credentials, or no such repository. Startup stops on it. */
function permanentLookupError(err: unknown): boolean {
  return err instanceof GitHubError && (err.status === 401 || err.status === 404);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** What startupProject needs: the store holding the key, the forge lookup, and where to log and wait. */
export interface StartupProjectDeps {
  store: Pick<FactoryStore, "getCursor" | "advanceCursor" | "listSettingOverrides" | "listWorkItems">;
  lookup: RepoLookup;
  repo: RepoRef;
  clock: Clock;
  log: Logger;
  /** Stops the wait for a first resolution (SIGTERM, a drain). */
  signal?: AbortSignal;
}

/**
 * The configured repo's project at startup (design 2026-11-07): GitHub is a sync plugin, so a start never waits
 * on it once the key is known. The stored key comes first; the returned `refreshed` is one background GitHub read
 * that stores the current label (a rename) and logs, never throws, when GitHub fails or is rate limited. Only a
 * store that has never had the key (a first start) asks GitHub before returning: a rate limit, an outage or a
 * network error is logged and retried, waiting PROJECT_RETRY_MS and doubling up to 10 minutes, until it resolves
 * or `signal` stops it. Every stored item, command and run carries the key, so before the first resolution there
 * is nothing local to process. A 401 or a 404 stops startup with the configured repo and the reason.
 */
export async function startupProject(d: StartupProjectDeps): Promise<{ project: ProjectRef; refreshed: Promise<void> }> {
  const known = await storeProjectResolver(d.store, d.repo)();
  if (known) {
    // A store written before the key cursor: found by its label, stored now so the next start reads it directly.
    await saveProject(d.store, d.repo, known);
    const refreshed = resolveProject(d.lookup, d.repo).then(
      async (now) => {
        if (now.key === known.key) {
          await saveProjectLabel(d.store, now);
          return;
        }
        await saveProject(d.store, d.repo, now);
        d.log.warn("GitHub reports another repository ID for the configured repo; the next start uses it", { project: now.label });
      },
    ).catch((err: unknown) => d.log.warn("GitHub unreachable at startup; using the stored project key", { project: known.label, error: errorText(err) }));
    return { project: known, refreshed };
  }
  for (let wait = PROJECT_RETRY_MS; ; wait = Math.min(wait * 2, PROJECT_RETRY_MAX_MS)) {
    try {
      const project = await resolveProject(d.lookup, d.repo);
      await saveProject(d.store, d.repo, project);
      return { project, refreshed: Promise.resolve() };
    } catch (err) {
      if (permanentLookupError((err as { cause?: unknown }).cause)) throw err;
      d.log.warn("the configured repo's project key is not stored yet and GitHub cannot resolve it; retrying", {
        repo: `${d.repo.owner}/${d.repo.name}`, retry_in_ms: wait, error: errorText(err),
      });
    }
    await d.clock.sleep(wait, d.signal);
  }
}

/**
 * The project at startup: with no GitHub plugin selected, the local project, stored as the configured repo's key
 * (#350's cursor) with no GitHub call; else startupProject.
 */
async function projectAtStartup(loaded: Loaded, d: StartupProjectDeps): Promise<{ project: ProjectRef; refreshed: Promise<void> }> {
  if (loaded.config.local_only !== true) return startupProject(d);
  const project = localProject(d.repo);
  await saveProject(d.store, d.repo, project);
  return { project, refreshed: Promise.resolve() };
}

/** A stand-in that refuses every call with `why`. Not a thenable: awaiting it must not hang. */
function refusing<T>(why: string): T {
  return new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : () => Promise.reject(new Error(why))) }) as T;
}

const NO_GITHUB = "no GitHub plugin is selected (design 05-sources, Local startup): nothing calls GitHub";

/**
 * Shares GitHub's rate limit through the store from now on (design 05-sources, call budget): every process that
 * calls GitHub reads the last response any replica got, at most once per tick, and writes its own. With no GitHub
 * plugin selected there is no client, and no budget row is written.
 */
function shareGitHubBudget(loaded: Loaded, github: GitHubApi, store: FactoryStore, config: FactoryConfig): void {
  if (loaded.config.local_only !== true) github.shareBudget({ store, project: config.project.key, refresh_ms: config.tick_ms });
}

/** The loaded config with the resolved project, and the per-project settings re-keyed from `owner/name` to its key. */
export function resolvedConfig(config: LoadedConfig, project: ProjectRef): FactoryConfig {
  const ownerName = `${config.repo.owner}/${config.repo.name}`;
  return { ...config, project, settings: { ...config.settings, projects: rekeyProjectSettings(config.settings.projects, ownerName, project.key) } };
}

export interface Built {
  loaded: Loaded;
  clock: Clock;
  store: FactoryStore;
  secrets: SecretStore;
  /** The configured repo, from the store, or from GitHub on a first start (startupProject). */
  project: ProjectRef;
  controller: ControllerRole;
  /** `config.max_workers` worker slots, `workers` of them claiming; `run(signal)` runs them all. */
  worker: WorkerPool;
  close(): Promise<void>;
}

/** What every broker plugin is built with, beside the base context. */
interface BrokerDeps { github: GitHubApi; credentials: GitHubCredentials; secrets: SecretStore; store: FactoryStore; scanner: EgressScanner; clock: Clock }

/**
 * Resolves the configured plugins one at a time, through the same registry as build(). For code that needs
 * only some of them: setup, doctor and the G6 canary, so they exercise the configured guards.
 */
export class Plugins {
  readonly base: BaseContext;
  /** The github_auth plugin's build, made once: one forge client per Plugins, so per build() and per command. */
  private access: Promise<GitHubAccess> | undefined;

  constructor(
    readonly loaded: Loaded,
    opts: { extraScanValues?: readonly string[] } = {},
  ) {
    const { owner, name } = loaded.config.repo;
    this.base = { loaded, repo: { owner, name }, extraScanValues: opts.extraScanValues ?? [] };
  }

  clock(): Promise<Clock> {
    return createPlugin(this.loaded.registry, "clock", this.loaded.plugins.clock, this.base);
  }
  secrets(): Promise<SecretStore> {
    return createPlugin(this.loaded.registry, "secrets", this.loaded.plugins.secrets, this.base);
  }
  scanner(secrets: SecretStore): Promise<EgressScanner> {
    return createPlugin(this.loaded.registry, "egress", this.loaded.plugins.egress, { ...this.base, secrets });
  }
  store(secrets: SecretStore, clock: Clock): Promise<FactoryStore> {
    return createPlugin(this.loaded.registry, "store", this.loaded.plugins.store, { ...this.base, secrets, clock });
  }
  /** One provider, or a FallbackLLM over the `plugins.llm` chain (design 2026-11-07). */
  async llm(secrets: SecretStore): Promise<LLMProvider> {
    const names = selectedLlms(this.loaded.plugins);
    const members = [];
    for (const name of names) members.push({ name, impl: await createPlugin(this.loaded.registry, "llm", name, { ...this.base, secrets }) });
    return members.length === 1 ? members[0]!.impl : new FallbackLLM(members);
  }
  sandbox(): Promise<Sandbox> {
    return createPlugin(this.loaded.registry, "sandbox", this.loaded.plugins.sandbox, this.base);
  }
  /**
   * The credentials and the one forge client the selected github_auth plugin builds, on the first call; later
   * calls get the same ones. With no GitHub plugin selected (design 05-sources, Local startup): stand-ins that
   * refuse every call, so no GitHub credential is read and no request is made. `deps`: the secret store and Clock
   * a caller already has (build()); absent, the configured ones.
   */
  githubAccess(deps?: { secrets: SecretStore; clock: Clock }): Promise<GitHubAccess> {
    this.access ??= this.loaded.config.local_only === true
      ? Promise.resolve({ credentials: refusing<GitHubCredentials>(NO_GITHUB), api: refusing<GitHubApi>(NO_GITHUB) })
      : (async () => {
          const { secrets, clock } = deps ?? { secrets: await this.secrets(), clock: await this.clock() };
          return createPlugin(this.loaded.registry, "github_auth", this.loaded.plugins.github_auth, { ...this.base, secrets, clock });
        })();
    return this.access;
  }
  /** The process's forge client (githubAccess): what the CLI commands, setup and doctor call the forge through. */
  async githubApi(): Promise<GitHubApi> {
    return (await this.githubAccess()).api;
  }
  /**
   * Where local items go (design 05-sources, Local items): the `local` broker and the selected sandbox plugin on
   * the local base branch. With no GitHub plugin selected those are `selected` already; otherwise both are built
   * here beside them, from the same registry, with no new config key. Never a credential: the local broker has none.
   */
  async localRoute(selected: LocalRoute, deps: BrokerDeps): Promise<LocalRoute> {
    if (this.loaded.config.local_only === true) return selected;
    const loaded: Loaded = { ...this.loaded, config: { ...this.loaded.config, local_only: true } };
    const base = { ...this.base, loaded };
    const sandbox = await createPlugin(loaded.registry, "sandbox", loaded.plugins.sandbox, base);
    const broker = this.loaded.plugins.broker === LOCAL_BROKER ? selected.broker : await createPlugin(loaded.registry, "broker", LOCAL_BROKER, { ...base, ...deps });
    return { broker, sandbox };
  }
  /** `tools`: the broker and scanner a runner exposes granted tools through; left out where nothing is granted. */
  /** One runner, or a FallbackRunner over the `plugins.runner` chain (design 2026-11-07). */
  async runner(sandbox: Sandbox, secrets: SecretStore, tools?: { broker: ToolBroker; scanner: EgressScanner }): Promise<AgentRunner> {
    const names = selectedRunners(this.loaded.plugins);
    const members = [];
    for (const name of names) {
      members.push({ name, impl: await createPlugin(this.loaded.registry, "runner", name, { ...this.base, sandbox, secrets, ...tools }) });
    }
    return members.length === 1 ? members[0]!.impl : new FallbackRunner(members);
  }
  testDatabase(secrets: SecretStore) {
    return createPlugin(this.loaded.registry, "test_database", this.loaded.plugins.test_database, { ...this.base, secrets });
  }
  /**
   * The selected forge (`plugins.forge`, or the one `plugins.source` implies; issue #273), or null when config
   * selects none: then nothing is built. `sync`: the store, Clock and log build() also hands it, so the GitHub forge
   * records its PR comments and labels and can poll.
   */
  async forge(
    github: GitHubApi, sync: { store: FactoryStore; clock: Clock; log: Logger; credentials?: GitHubCredentials } | null = null,
  ): Promise<Forge | null> {
    const name = this.loaded.plugins.forge;
    if (name === undefined) return null;
    const ctx = { ...this.base, github, ...sync };
    return createPlugin(this.loaded.registry, "forge", name, ctx);
  }
}

export async function build(
  loaded: Loaded,
  opts: { clock?: Clock; extraScanValues?: string[]; workerIndexBase?: number; repoLookup?: RepoLookup; signal?: AbortSignal } = {},
): Promise<Built> {
  const { stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded, opts);
  const base = p.base;
  const clock = opts.clock ?? (await p.clock());
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();

  const scanner = await p.scanner(secrets);
  // G1 on the toolchain env values, by the configured scanner, before anything is built that could start an agent.
  await checkToolchainEnv(loaded.config.toolchain, scanner);
  // The one forge client of this build: every plugin that calls the forge gets it; only the broker and the forge (its
  // writes are outbound's, RFC 0015 M7) get credentials.
  const { credentials, api: github } = await p.githubAccess({ secrets, clock });
  const sandbox = await p.sandbox();

  // One adapter per listed source; the controller routes each item to the one of its source type.
  const sources = [];
  const sourceLog = new ConsoleLogger(clock, "source");
  for (const name of selectedSources(sel)) {
    sources.push(await createPlugin(registry, "source", name, { ...base, github, store, secrets, scanner, log: sourceLog, clock }));
  }
  // PR events, PR facts, PR comments and PR status (issue #273); null when config selects no forge.
  const forge = await p.forge(github, { store, clock, log: new ConsoleLogger(clock, "forge"), credentials });
  // Grant sources first: the auth plugin's authorize asks them (src/core/authorize.ts, design 2026-11-01).
  const grants = await createGrants(GRANTS, loaded.grants, { ...base, github });
  const authPlugin = await createPlugin(registry, "auth", sel.auth, { ...base, github, store, grants });
  // Local commands (CLI, local UI) by their own auth plugin, `local` by default (issue #318): never GitHub's.
  const localAuthPlugin = await createPlugin(registry, "auth", selectedLocalAuth(sel), { ...base, github, store, grants });
  // Identity (RFC 0015 §8, M9): edge, service and run passports, and the audit of every authorize decision.
  const identity = await startProcessIdentity(loaded, store, clock, authPlugin);
  const auth = new AuditedAuthProvider(authPlugin, identity.passports);
  const local_auth = new AuditedAuthProvider(localAuthPlugin, identity.passports);
  // Suggests a command for a plain-language comment; never changes state (design §4). The worker pool's improve
  // runs draft a cause and fix per failure group through it, with no tools (design §7).
  const llm = await p.llm(secrets);
  // The broker before the runner: the runner exposes granted broker tools through it (`tool_grants`).
  const brokerDeps: BrokerDeps = { github, credentials, secrets, store, scanner, clock };
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, ...brokerDeps });
  // Checked here, not in loadConfig: the broker's tool list comes from its plugin. Read-only tools only.
  const tool_grants = toolGrantsConfig(loaded.file.tool_grants, broker, sel.broker);
  // Local items take the local broker and sandbox, by their source type, never the selected forge's (design 05-sources).
  const unguardedLocal = await p.localRoute({ broker, sandbox }, brokerDeps);
  // G2 with run passports: every broker the worker pool or an agent's granted tools reach checks the run passport.
  const passports = new RunPassports(identity.passports);
  const guard = (b: ToolBroker): ToolBroker => new PassportToolBroker(b, { checker: identity.passports, passportOf: (run) => passports.passportOf(run) });
  const local = { ...unguardedLocal, broker: guard(unguardedLocal.broker) };
  const guarded = guard(broker);
  const runner = await p.runner(sandbox, secrets, { broker: guarded, scanner });
  const granted = [...new Set(Object.values(tool_grants ?? {}).flat())];
  if (granted.length > 0 && !runner.exposes_tools) {
    throw new Error(`tool_grants grants ${granted.join(", ")}, but the ${selectedRunners(sel).join(", ")} agent runner cannot expose broker tools; remove tool_grants or pick a runner that can`);
  }
  const storage = await createPlugin(registry, "storage", sel.storage, base);
  const awake = await createPlugin(registry, "awake", sel.awake, { ...base, clock });
  // The pre-push checks' database (design §4): its URL reaches only the check commands, never an agent.
  const testDatabase = await p.testDatabase(secrets);
  // list-all has no source for its capabilities yet, so it finds nothing and the prompt gets no index.
  const capability = await createPlugin(registry, "capability", sel.capability, { ...base, capabilities: [] });
  // The network pause's probe (design §5 Restarts): only the endpoints of the plugins selected above.
  const network_probe = await createPlugin(registry, "network_probe", sel.network_probe, base);
  // The bus and the tick generators the roles run on (RFC 0015 §5, design 10-event-driven).
  const bus = await createPlugin(registry, "bus", sel.bus, base);
  const ticks = await createPlugin(registry, "ticks", sel.ticks, base);
  // The worker's ExecutionEngine (RFC 0015 §7): one per worker loop, built by the pool.
  const engines = await createPlugin(registry, "engine", sel.engine, { ...base, store });

  // Startup resolution (design 2026-11-07), after every plugin check so a bad selection is reported first: the
  // project key every write uses, from the store; GitHub refreshes the label in the background (a rename). With
  // no GitHub plugin: the local project key, and no GitHub call.
  const { project, refreshed } = await projectAtStartup(loaded, {
    store, lookup: opts.repoLookup ?? github, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup"), ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const config: FactoryConfig = { ...resolvedConfig(loaded.config, project), ...(tool_grants ? { tool_grants } : {}) };
  await checkEnabledHooks(config.hooks ?? []);
  shareGitHubBudget(loaded, github, store, config);

  // Runtime overrides (design 2026-11-03): one cache of file values plus stored overrides, shared by the
  // controller and the worker pool, refreshed each tick. The file's per-project blocks are keyed by project key.
  const settings = new LiveSettings({
    config,
    base: { ...settingsBase(loaded), layers: config.settings },
    source: store,
    log: new ConsoleLogger(clock, "settings"),
  });
  await settings.refresh();

  const controller = new ControllerRole({
    identity,
    store,
    sources,
    forge,
    auth,
    local_auth,
    service_auth: controllerServiceAuth(identity.passports),
    outbound_auth: outboundServiceAuth(identity.passports),
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
    llm,
    network_probe,
    bus,
    ticks,
    // Owner of a stream source's listener lease while this process holds it (docs/architecture.md, Intake).
    replica_id: `${hostname()}:${process.pid}`,
    // The factory repo's git writes under this machine's stable host id; a SQLite store (solo) flushes every host's.
    git_host: gitHost(stateDir, sel.store),
    settings,
    // The worker pool's sandbox: the controller's local merge check fetches and checks through it (design §5).
    sandbox,
    // The alarm step's restart count (design 05-alarms): this host's supervisor status file.
    restarts: () => readRestarts(join(loaded.stateDir, SUPERVISOR_STATUS_FILE)),
    // This process's GitHub budget, stored after each poll for the status page (design §5, GitHub call budget).
    // With no GitHub plugin selected (Local startup) there is no GitHub client and no budget to record.
    // The shared budget is read before each tick's optional reads, at most once per tick.
    ...(loaded.config.local_only === true ? {} : { github_budget: () => github.status(), refresh_forge_budget: () => github.refreshSharedBudget() }),
    // The red-main check after an automatic merge (design 03-risk) runs the checks with the worker's base env.
    check_env: baseEnv(),
  });

  const worker = new WorkerPool({
    id_prefix: `${hostname()}:${process.pid}`,
    // A run's push and PR go to this machine's git destination (`git:<host id>:<branch>`), which its controller flushes.
    host: hostId(stateDir),
    // The supervisor's block for this child (git-worktree updater); unset: 0.
    index_base: opts.workerIndexBase ?? workerIndexBase(process.env[WORKER_INDEX_BASE_ENV]),
    // The revision the supervisor built this child from, stamped on each run (`worker_runs.code_version`); unset: dev.
    ...codeVersion(process.env[CODE_VERSION_ENV]),
    store,
    sandbox,
    runner,
    broker: guarded,
    local,
    passports,
    scanner,
    storage,
    llm,
    clock,
    config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(),
    // Split over the claiming slots as SF_TEST_WORKERS, so parallel test runs do not each take every CPU.
    cpus: availableParallelism(),
    models: { table: loaded.model_by, names: loaded.models },
    awake,
    capability,
    testDatabase,
    settings,
    engines,
    ticks,
    // A run's PR comment is a thread entry on this ref; outbound posts it (RFC 0015 M7).
    ...(forge ? { prRef: (pr: number) => forge.prRef(pr) } : {}),
  });

  return { loaded, clock, store, secrets, project, controller, worker, close: () => refreshed.then(() => identity.stop()).then(() => store.close()) };
}

/**
 * This process's Identity on the store's database, its key in the state folder (denied to agents). Forge and chat
 * accounts resolve through the selected auth plugin's mapping; local ones through Identity's own.
 */
export async function startProcessIdentity(loaded: Loaded, store: FactoryStore, clock: Clock, auth?: AuthProvider): Promise<IdentityRuntime> {
  const log = new ConsoleLogger(clock, "identity");
  return startIdentity({
    db: storeSql(store),
    stateDir: loaded.stateDir,
    ...(auth ? { providers: (["github", "slack", "oidc"] as const).map((p) => new PluginIdentityProvider(p, auth)) } : {}),
    onError: (schedule, err) => log.error("identity tick failed", { step: schedule, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" }),
  });
}

/** `workers` from factory.config.json: absent means 1, otherwise an integer of 1 or more or startup fails. */
export { maxWorkers, workerCount };

/**
 * What factory.config.json says about each settable key, before any override (design 2026-11-03): the global keys
 * as written in the file (absent: not set there), and the checked per-project layers, still keyed by `owner/name`
 * as the file writes them. build() swaps in the layers re-keyed to the project key.
 */
export function settingsBase(loaded: Pick<Loaded, "file" | "config">): SettingsBase {
  const raw = loaded.file as unknown as Record<string, unknown>;
  const file: Partial<Record<GlobalSettableKey, unknown>> = {};
  for (const k of SETTABLE_KEYS) {
    if (isProjectSettableKey(k)) continue;
    if (raw[k] !== undefined) file[k] = raw[k];
  }
  return { file, layers: loaded.config.settings, ...(loaded.config.max_workers !== undefined ? { max_workers: loaded.config.max_workers } : {}) };
}

/** SF_WORKER_INDEX_BASE as set by the supervisor: unset, empty or not a non-negative integer means 0. */
export function workerIndexBase(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 0;
  return Number.parseInt(value.trim(), 10);
}

/** `hooks` from factory.config.json: a list of hook names, or startup fails. */
export function hookNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("hooks must be a list of hook names");
  return value as string[];
}

/** Every enabled hook name must be a discovered `*.hook.ts`: a typo would otherwise leave the owner's check off. */
export async function checkEnabledHooks(enabled: readonly string[]): Promise<void> {
  if (enabled.length === 0) return;
  const known = new Set((await loadHooks()).map((h) => h.descriptor.name));
  const missing = enabled.filter((n) => !known.has(n));
  if (missing.length > 0) throw new Error(`hooks: no discovered hook named ${missing.join(", ")}`);
}

/** SF_CODE_VERSION as set by the supervisor: the revision, trimmed; unset or blank: none (the worker stamps `dev`). */
export function codeVersion(value: string | undefined): { code_version?: string } {
  const rev = value?.trim();
  return rev ? { code_version: rev } : {};
}

export const DEFAULT_UI_PORT = 4310;

/** `ui.port` from factory.config.json: absent means 4310, otherwise an integer 1–65535 or startup fails. */
export function uiPort(ui: FileConfig["ui"]): number {
  const port = ui?.port;
  if (port === undefined) return DEFAULT_UI_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ui.port must be an integer from 1 to 65535");
  }
  return port;
}

/**
 * `ui.user_id` from factory.config.json: absent means null (uiCommandsActor decides), otherwise a
 * non-empty string (a factory user ID, never a display name) or startup fails naming the key.
 */
export function uiUserId(ui: FileConfig["ui"]): UserId | null {
  const id: unknown = ui?.user_id;
  if (id === undefined) return null;
  if (typeof id !== "string" || id.trim() === "") throw new Error("ui.user_id must be a non-empty string (a factory user ID)");
  return id.trim() as UserId;
}

/** True for a loopback bind address: only this machine's user can reach the server. */
export function isLoopback(bind: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(bind.trim().toLowerCase());
}

/**
 * Who the page's commands act as (design 09, 2026-11-08): `ui.user_id` when set (source `config`); else, on a
 * loopback server, the CLI identity of this machine (`cli_user` is `config`, git user.email or the OS user is
 * `environment`), so a solo setup needs no key. A server on any other address needs `ui.user_id`: null.
 * Commands are then authorized as any local command is (the auth plugin; `local:anonymous` holds no role).
 */
export function uiCommandsActor(uiUser: UserId | null, cli: CliIdentity, bind: string): Pick<UiCommands, "actor" | "source"> {
  if (uiUser !== null) return { actor: uiUser, source: "config" };
  if (!isLoopback(bind)) return { actor: null, source: null };
  return { actor: cli.user, source: cli.from === "cli_user" ? "config" : "environment" };
}

export interface UiParts {
  clock: Clock;
  store: FactoryStore;
  scanner: EgressScanner;
  /** The Settings page's write path (design §8, issue #236): the config base, repo, actor, store-only resolver, CSRF token. */
  settings: UiSettings;
  /** The item commands route (POST /api/v1/items/:id/commands, issue #227): its actor and the per-process token. */
  commands: UiCommands;
  /** The "Resume now" route (design §5 Restarts, issue #291): the page's factory user, the owner check, the CSRF token. */
  pauses: UiPauses;
  /** Display names by user id from Identity's identity_profiles (M9), only to show. */
  displayNames: (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  close(): Promise<void>;
}

/** The UI process makes no forge call (design §8): the grants and the auth plugin get a client that refuses each one. */
const NO_FORGE = refusing<GitHubApi>("the UI process makes no forge call");

/**
 * What the status page needs and nothing more: no controller, worker, source or runner, and no forge client.
 * Built through Plugins (the configured store, secrets and egress scanner). The secret store is loaded only
 * because the MySQL store needs MYSQL_PASSWORD and the scanner needs the known secret values; neither reaches
 * the page. The Settings page finds the configured repo's project key from the stored project label
 * (storeProjectResolver), so the UI process never calls the forge or reads a forge credential. `identity` is the
 * CLI identity main.ts resolves (cliIdentity); its user is the Settings writer. The CSRF token is made here, per
 * process, and kept only in memory. The commands route acts as uiCommandsActor says and takes the same token. The pause route's owner
 * check uses the auth plugin over the local grants only, with a client that makes no forge call.
 */
export async function buildUiParts(loaded: Loaded, opts: { identity: CliIdentity }): Promise<UiParts> {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();
  const scanner = await p.scanner(secrets);
  const { owner, name } = loaded.config.repo;
  const token = newCsrfToken();
  const settings: UiSettings = {
    base: settingsBase(loaded),
    repo: { owner, name },
    actor: opts.identity.user,
    resolveProject: storeProjectResolver(store, { owner, name }),
    csrfToken: token,
  };
  // The owner check for "Resume now" and the Merge button's approve_merge check: the configured auth plugin over the
  // local grants only (a remote grant such as github-permission would call the forge, so it is left out here;
  // `factory resume` needs no grant). A remote-only grant therefore shows no Merge button.
  const base = p.base;
  const grants = (await createGrants(GRANTS, loaded.grants, { ...base, github: NO_FORGE })).filter((g) => !g.remote);
  const authPlugin = await createPlugin(loaded.registry, "auth", loaded.plugins.auth, { ...base, github: NO_FORGE, store, grants });
  // Identity (M9): the page's commands carry the actor's edge passport, and every decision here is audited.
  const identity = await startProcessIdentity(loaded, store, clock, authPlugin);
  const auth = new AuditedAuthProvider(authPlugin, identity.passports);
  const onProject = async (user_id: UserId, action: AuthAction): Promise<AuthDecision> => {
    const project = await settings.resolveProject();
    if (!project) return { allow: false, reason: "no project is stored yet" };
    return auth.authorize({ user_id, attributes: {} }, action, { kind: "project", id: project.key });
  };
  // One token per process for every write route; held only in memory, never written to a file, the store or a log.
  const who = uiCommandsActor(uiUserId(loaded.file.ui), opts.identity, UI_BIND);
  const actor = who.actor;
  const commands: UiCommands = {
    ...who, token,
    mergeAllowed: async () => actor !== null && (await onProject(actor, "approve_merge")).allow,
    ...(actor !== null ? { passport: () => identity.edge({ provider: "local", subject: actor }, "ui") } : {}),
  };
  // The mode switch and the auto-merge tier need approve_merge on the project (design 08-settings), as the Merge button.
  settings.mayApproveMerge = async () => refusalOf(await onProject(opts.identity.user, "approve_merge"));
  const cliUser = cliUserConfig(loaded.file);
  const pauses: UiPauses = {
    // A local account linked to a factory user first, else `cli_user`: an ID, never a display name.
    principal: async () => (await auth.resolve({ provider: "local", subject: opts.identity.user.replace(/^local:/, "") }))?.user_id ?? cliUser,
    authorize: (user_id) => onProject(user_id, "approve_spec"),
    csrfToken: token,
    log: new ConsoleLogger(clock, "ui"),
  };
  const profiles = new ProfileStore(storeSql(store));
  const displayNames = (ids: readonly string[]) => profiles.displayNames(ids);
  return { clock, store, scanner, settings, commands, pauses, displayNames, close: () => identity.stop().then(() => store.close()) };
}

function refusalOf(d: AuthDecision): string | null {
  return d.allow ? null : d.reason;
}

/**
 * The approve_merge check of `factory settings` and `factory mode` for `mode` and `auto_merge_max_tier` (design
 * 08-settings): `user` on the configured project, through the local auth plugin over the local grants, with no forge
 * call. Solo: the first local identity is the owner and holds it with no setup. The refusal, or null.
 */
export async function approveMergeCheck(loaded: Loaded, store: FactoryStore, user: UserId): Promise<() => Promise<string | null>> {
  const base = new Plugins(loaded).base;
  const grants = (await createGrants(GRANTS, loaded.grants, { ...base, github: NO_FORGE })).filter((g) => !g.remote);
  const auth = await createPlugin(loaded.registry, "auth", selectedLocalAuth(loaded.plugins), { ...base, github: NO_FORGE, store, grants });
  const repo = { owner: loaded.config.repo.owner, name: loaded.config.repo.name };
  return async () => {
    const project = (await storeProjectResolver(store, repo)()) ?? (loaded.config.local_only ? localProject(repo) : null);
    if (!project) return "no project key is stored yet; start the factory once first";
    return refusalOf(await auth.authorize({ user_id: user, attributes: {} }, "approve_merge", { kind: "project", id: project.key }));
  };
}

/** What `factory session` needs (design §5, 2026-11-01): no controller, worker, source or agent runner. */
export interface SessionParts {
  clock: Clock; store: FactoryStore; scanner: EgressScanner; sandbox: Sandbox; broker: ToolBroker; auth: AuthProvider; github: GitHubApi; config: FactoryConfig;
  /** The local items' broker and sandbox, as the worker pool's (Plugins.localRoute). */
  local: LocalRoute;
  close(): Promise<void>;
}

/** build()'s parts a session uses, through the same registry; the broker is its only push and PR path. Live settings. */
export async function buildSessionParts(loaded: Loaded): Promise<SessionParts> {
  const { stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const [base, clock, secrets] = [p.base, await p.clock(), await p.secrets()];
  const store = await p.store(secrets, clock);
  await store.migrate();
  const [scanner, { credentials, api: github }, sandbox] = [await p.scanner(secrets), await p.githubAccess({ secrets, clock }), await p.sandbox()];
  const grants = await createGrants(GRANTS, loaded.grants, { ...base, github });
  const auth = await createPlugin(registry, "auth", sel.auth, { ...base, github, store, grants });
  const brokerDeps: BrokerDeps = { github, credentials, secrets, store, scanner, clock };
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, ...brokerDeps });
  const local = await p.localRoute({ broker, sandbox }, brokerDeps);
  const { project, refreshed } = await projectAtStartup(loaded, { store, lookup: github, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup") });
  const config = resolvedConfig(loaded.config, project);
  shareGitHubBudget(loaded, github, store, config);
  const settings = new LiveSettings({ config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, log: new ConsoleLogger(clock, "settings") });
  await settings.refresh();
  return { clock, store, scanner, sandbox, broker, local, auth, github, config: settings.config(), close: () => refreshed.then(() => store.close()) };
}

/**
 * The configured store for `factory stats`, and nothing else. Unlike build() and buildUiParts() it never
 * calls migrate(): stats writes nothing, not even a schema change. The secret store is loaded only because
 * the MySQL store needs MYSQL_PASSWORD.
 */
export async function buildStatsStore(loaded: Loaded): Promise<FactoryStore> {
  const p = new Plugins(loaded);
  const clock = await p.clock();
  return p.store(await p.secrets(), clock);
}

export const STATS_MIN_SAMPLE_DEFAULT = 10;

/**
 * The `stats` key (design §6): every severity needs a weight that is a finite number ≥ 0, and `min_sample`
 * (absent: 10) is an integer ≥ 1, or startup fails. There are no default weights.
 */
export function statsConfig(raw: FileConfig["stats"]): StatsConfig {
  const weights = raw?.weights;
  if (typeof weights !== "object" || weights === null || Array.isArray(weights)) {
    throw new Error(`stats.weights must be an object with a weight for each of ${VERDICT_SEVERITIES.join(", ")}`);
  }
  const w = weights as Record<string, unknown>;
  const checked = {} as Record<VerdictSeverity, number>;
  for (const s of VERDICT_SEVERITIES) {
    const v = w[s];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`stats.weights.${s} must be a number ≥ 0`);
    }
    checked[s] = v;
  }
  const min_sample = raw?.min_sample === undefined ? STATS_MIN_SAMPLE_DEFAULT : raw.min_sample;
  if (typeof min_sample !== "number" || !Number.isInteger(min_sample) || min_sample < 1) {
    throw new Error("stats.min_sample must be an integer ≥ 1");
  }
  return { weights: checked, min_sample };
}

/** MYSQL_HOST / _PORT / _DATABASE / _USER in the secret file override factory.config.json, per machine. */
async function storeConfig(base: StoreConfig, secretsFile: string): Promise<StoreConfig> {
  if (base.type !== "mysql") return base;
  const env = await readEnvSettings(secretsFile, ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER"]);
  const s = {
    ...base,
    host: env.get("MYSQL_HOST") ?? base.host,
    port: Number(env.get("MYSQL_PORT") ?? base.port),
    database: env.get("MYSQL_DATABASE") ?? base.database,
    user: env.get("MYSQL_USER") ?? base.user,
  };
  if (!Number.isInteger(s.port)) throw new Error("MYSQL_PORT must be a number");
  if (!(isSqlName(s.database) && isSqlName(s.user))) throw new Error("MySQL database and user must match [A-Za-z0-9_]+");
  return s;
}

export function isSqlName(s: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(s);
}

/** Absent: ["npm", "test"]. Otherwise a non-empty argv of non-empty strings, or startup fails. */
export function testCommand(value: unknown): string[] {
  return argvConfig("repo.test_command", value, ["npm", "test"]);
}

/**
 * `repo.check_commands`: absent → nothing (the core falls back to `[test_command]`); otherwise a non-empty list
 * of argv, each a non-empty array of non-empty strings, or startup fails.
 */
export function checkCommandsConfig(value: unknown): { check_commands?: string[][] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('repo.check_commands must be a non-empty list of argv, e.g. [["npm", "run", "typecheck"], ["npm", "test"]]');
  }
  return { check_commands: value.map((v, i) => argvConfig(`repo.check_commands[${i}]`, v, ["npm", "test"])) };
}

/**
 * `toolchain` from factory.config.json (design 05-sandbox.md, issue #334): absent → undefined. Otherwise
 * `caches` is a list of absolute folders (a leading `~` is the owner's HOME), normalized, none overlapping a
 * `deny_paths` entry in either direction (so neither the secret file's folder nor the owner's config); `env` maps
 * env var names to strings, each key passing the G1 key check (`toolchainEnvKeyRefusal`); `warm_command` is argv,
 * absent: `install_command`. Every problem fails startup at once, one per line, each naming its entry. The values
 * are scanned for secrets in build(), by the configured scanner (`checkToolchainEnv`).
 */
export function toolchainConfig(
  raw: unknown,
  ctx: { home: string; install_command: readonly string[]; deny_paths: readonly string[] },
): ToolchainConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("toolchain must be an object with caches, env and warm_command");
  const problems: string[] = [];
  const caches: string[] = [];
  if (raw.caches !== undefined && !Array.isArray(raw.caches)) problems.push("toolchain.caches must be a list of absolute folders");
  (Array.isArray(raw.caches) ? (raw.caches as unknown[]) : []).forEach((c, i) => {
    const expanded = typeof c === "string" && (c === "~" || c.startsWith("~/")) && ctx.home !== "" ? join(ctx.home, c.slice(1)) : c;
    if (typeof expanded !== "string" || !expanded.startsWith("/")) {
      problems.push(`toolchain.caches[${i}] must be an absolute folder (or start with ~/), got ${JSON.stringify(c) ?? String(c)}`);
    } else caches.push(resolve(expanded));
  });
  for (const o of toolchainCacheOverlaps(caches, ctx.deny_paths.map((d) => resolve(d)))) {
    problems.push(`toolchain.caches[${o.index}] ${o.cache} overlaps the denied path ${o.denied}`);
  }
  const env: Record<string, string> = {};
  if (raw.env !== undefined && !isRecord(raw.env)) problems.push("toolchain.env must be an object of env var names to strings");
  for (const [key, value] of Object.entries(isRecord(raw.env) ? raw.env : {})) {
    const refusal = toolchainEnvKeyRefusal(key);
    if (refusal) problems.push(refusal);
    else if (typeof value !== "string") problems.push(`toolchain.env.${key} must be a string`);
    else env[key] = value;
  }
  let warm_command: string[] = [...ctx.install_command];
  try {
    warm_command = argvConfig("toolchain.warm_command", raw.warm_command, ctx.install_command);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { caches, env, warm_command };
}

/**
 * G1 on the toolchain's env values at startup: each value goes through the configured egress scanner (known
 * secret values and secret patterns), so a token pasted into `toolchain.env` never reaches an agent. Fails naming
 * the entry and the rule, never the value. No block, or no entry: nothing is scanned.
 */
export async function checkToolchainEnv(toolchain: ToolchainConfig | undefined, scanner: EgressScanner): Promise<void> {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(toolchain?.env ?? {})) {
    const scan = await scanner.scan("log", value);
    if (!scan.clean) problems.push(`toolchain.env.${key} looks like a credential (${scan.findings.map((f) => f.rule).join(", ")}) (G1)`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** A gate command from config: absent → `fallback`; otherwise a non-empty argv of non-empty strings, or startup fails. */
export function argvConfig(key: string, value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v !== "")) {
    throw new Error(`${key} must be a non-empty array of non-empty strings (argv), e.g. ${JSON.stringify(fallback)}`);
  }
  return [...(value as string[])];
}

export const RETRY_DEFAULTS = { max_restart: 3, retry_base_ms: 60_000, retry_max_ms: 1_800_000 } as const;

/** The retry keys (design §5 Restarts) with their defaults. Positive integers, base ≤ max, or startup fails. */
export function retryConfig(
  file: Pick<FileConfig, "max_restart" | "retry_base_ms" | "retry_max_ms">,
): { max_restart: number; retry_base_ms: number; retry_max_ms: number } {
  const r = {
    max_restart: file.max_restart ?? RETRY_DEFAULTS.max_restart,
    retry_base_ms: file.retry_base_ms ?? RETRY_DEFAULTS.retry_base_ms,
    retry_max_ms: file.retry_max_ms ?? RETRY_DEFAULTS.retry_max_ms,
  };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
  }
  if (r.retry_base_ms > r.retry_max_ms) throw new Error("retry_base_ms must not exceed retry_max_ms");
  return r;
}

/**
 * `stall_ms`, `first_output_ms` and `probe_interval_ms` (design §5 Restarts) with their defaults
 * (STALL_DEFAULTS): positive integers, or startup fails.
 */
export function stallConfig(
  file: Pick<FileConfig, "stall_ms" | "first_output_ms" | "probe_interval_ms">,
): { stall_ms: number; first_output_ms: number; probe_interval_ms: number } {
  const r = {
    stall_ms: file.stall_ms === undefined ? STALL_DEFAULTS.stall_ms : file.stall_ms,
    first_output_ms: file.first_output_ms === undefined ? STALL_DEFAULTS.first_output_ms : file.first_output_ms,
    probe_interval_ms: file.probe_interval_ms === undefined ? STALL_DEFAULTS.probe_interval_ms : file.probe_interval_ms,
  };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
  }
  return r;
}

/**
 * The restart list of the supervisor status file (design 05-alarms). No file (not supervised, or the `none`
 * updater), one that does not parse, or one from before the list existed: none.
 */
export async function readRestarts(file: string): Promise<ChildRestart[]> {
  try {
    const status = JSON.parse(await readFile(file, "utf8")) as Partial<SupervisorStatus>;
    return Array.isArray(status.restarts) ? status.restarts : [];
  } catch {
    return [];
  }
}

/** The alarm keys (design 05-alarms) with their defaults (ALARM_DEFAULTS): positive integers, or startup fails. */
export function alarmConfig(
  file: Pick<FileConfig, "alarm_repeat_count" | "alarm_window_minutes" | "alarm_restart_count">,
): { alarm_repeat_count: number; alarm_window_minutes: number; alarm_restart_count: number } {
  return {
    alarm_repeat_count: positiveInteger("alarm_repeat_count", file.alarm_repeat_count ?? ALARM_DEFAULTS.alarm_repeat_count),
    alarm_window_minutes: positiveInteger("alarm_window_minutes", file.alarm_window_minutes ?? ALARM_DEFAULTS.alarm_window_minutes),
    alarm_restart_count: positiveInteger("alarm_restart_count", file.alarm_restart_count ?? ALARM_DEFAULTS.alarm_restart_count),
  };
}

/** `agent_stop_checks` (design §4 Pre-push gates): absent means 3, otherwise a positive integer or startup fails. */
export function agentStopChecks(file: Pick<FileConfig, "agent_stop_checks">): number {
  const v = file.agent_stop_checks;
  if (v === undefined) return AGENT_STOP_CHECKS_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("agent_stop_checks must be a positive integer");
  return v;
}

/** The deepest speculative merge queue: each level is one more merge-check run out at once. */
export const MERGE_QUEUE_DEPTH_MAX = 10;

/** `merge_queue.depth`: absent means 1 (solo: one check at a time), otherwise 1 to MERGE_QUEUE_DEPTH_MAX or startup fails. */
export function mergeQueueDepth(file: Pick<FileConfig, "merge_queue">): number {
  const v = file.merge_queue?.depth;
  if (v === undefined) return 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MERGE_QUEUE_DEPTH_MAX) {
    throw new Error(`merge_queue.depth must be an integer from 1 to ${MERGE_QUEUE_DEPTH_MAX}`);
  }
  return v;
}

export const DEFAULT_INBOX_RETENTION_DAYS = 14;

/** `inbox_retention_days`: absent means 14, otherwise a positive integer or startup fails. */
export function inboxRetentionDays(file: Pick<FileConfig, "inbox_retention_days">): number {
  const v = file.inbox_retention_days;
  if (v === undefined) return DEFAULT_INBOX_RETENTION_DAYS;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("inbox_retention_days must be a positive integer");
  return v;
}

function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}
