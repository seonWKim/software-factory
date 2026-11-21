// Composition root: the only place that reads env/files for config and picks implementations.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { availableParallelism, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type FactoryConfig, type LoadedConfig, type Prompts, type StatsConfig, type ToolchainConfig, cliUserConfig, uiCheckConfig,
  coordinationConfig, mergeQueuePushBase, readOnlyFolders, readOnlyInputsConfig, retentionConfig, toolGrantsConfig,
} from "./core/config.js";
import { toolchainEnvKeyRefusal } from "./core/tools/policy.js";
import { type ProjectRef, localProjectKey, projectLabel, rekeyProjectSettings } from "./core/project.js";
import { pathCompanionsConfig } from "./core/companions.js";
import { saveProject, saveProjectLabel } from "./core/project-labels.js";
import { errorText, type Logger } from "./core/log.js";
import type { CliEnvironment, CliIdentity } from "./core/local-cli.js";
import { canMergeLocal, forgeRoles } from "./core/local-merge.js";
import { StoredLearnedSettings } from "./core/learned-settings.js";
import type { Tier, UserId } from "./core/types.js";
import { budgetConfig } from "./core/budget.js";
import { type ModelNames, type ModelTable, parseModelBy, parseModels } from "./core/model-choice.js";
import { gitHost, hostId } from "./runtime/host-id.js";
import { ControllerRole } from "./runtime/roles/controller-role.js";
import { SqlHookAudit, loadHooks } from "./runtime/index.js";
import { PackCheckRunner } from "./runtime/hooks/pack-checks.js";
import { type HookDescriptor, UNCALLED_HOOK_POINTS } from "./shared/hook.js";
import {
  HEARTBEAT_LEASE_MESSAGE, type LearnedSettingsSource, booleanSetting, intakeLabel, LiveSettings, maxWorkers, settingValues, settingsLayers, workerCount,
} from "./core/settings.js";
import { settingsBase } from "./core/settings-base.js";
import { WorkerPool } from "./worker/index.js";
import type { LocalRoute } from "./worker/index.js";
import { type BrokerDeps, Plugins } from "./plugin-set.js";
import { checkConfigKeys, removedKeysWarning } from "./config-keys.js";
import { checkStatePaths } from "./state-paths.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubApi } from "./interfaces/github-credentials.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import { DEFAULT_STATUS_LABEL_PREFIX, type Forge } from "./interfaces/forge.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { AuthAction, AuthDecision, AuthProvider } from "./interfaces/auth-provider.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { CODE_VERSION_ENV, SUPERVISOR_STATUS_FILE, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";
import { updaterConfig } from "./impl/updater/config.js";
import { LOCAL_KEY_FILE, ProfileStore, startIdentity, type IdentityRuntime } from "./identity/index.js";
import { controllerServiceAuth, outboundServiceAuth } from "./impl/auth/audited-auth.js";
import { OwnerAuth } from "./core/authorize.js";
import { PassportToolBroker } from "./impl/broker/passport-broker.js";
import { type PackTool, packToolBrokers, withPackTools } from "./impl/broker/pack-tools.js";
import { storeSql } from "./impl/store/sql/store-sql.js";
import { RunPassports } from "./worker/passports/run-passports.js";
import type { RepoRef } from "./impl/github/github-client.js";
// The GitHub forge's descriptor: the one GitHub module a config with no GitHub plugin loads (descriptors only).
import { type RepoLookup, resolveProject } from "./impl/github/forge.plugin.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import type { UiCommands } from "./ui/commands.js";
import { type UiSettings, configWriter, newCsrfToken, storeProjectResolver } from "./ui/settings-api.js";
import type { UiPauses } from "./ui/pause-api.js";
import { type UiTacit, uiTacit } from "./ui/rules-api.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import { defaultSecretsFile } from "./impl/secrets/env-file-secret-store.js";
import { LiveTacit } from "./runtime/live-tacit.js";
import { LiveCalendars } from "./calendar/index.js";
import {
  INTEGRATION_KINDS, REGISTRY, type Registry, type Selection, createPlugin, selectPlugins, selectedRunners, selectedSources, withPackPlugins,
} from "./plugins.js";
import { batchingPolicies } from "./outbound/index.js";
import { type Pack, autoApproveReadOnly, findPacks, packChecks, packPluginFiles, packPrompts, packSkills } from "./packs/packs.js";
import { importedMcpRefusals, listRequestedMcpTools } from "./import/mcp-tool-lists.js";
import { startPackMcpServer } from "./impl/runner/pack-mcp-client.js";
import { PackGuidance } from "./impl/capability/project-guidance.js";
import { LearnedRules, joinGuidance } from "./core/learned-rules.js";
import type { FileConfig, StoreConfig } from "./compose-file.js";
import {
  agentStopChecks, alarmConfig, argvConfig, checkCommandsConfig, codeVersion, fillPrompt, mergeQueueDepth, readRestarts, retryConfig, stallConfig, statsConfig,
  testCommand, uiCommandsActor, uiPort, uiUserId, workerIndexBase,
} from "./compose-config.js";

// FileConfig and the plain config parsers live beside this file, so a new config key does not edit the composition root.
export * from "./compose-file.js";
export * from "./compose-config.js";

export { CODE_ROOT_ENV, CONFIG_ENV, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";

/** The checked-in config's name under the code root. */
export const CONFIG_FILE = "factory.config.json";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
  const { check_commands: rawChecks, ui_check: rawUiCheck, restart_command: rawRestart, ...fileRepo } = file.repo;
  const config: LoadedConfig = {
    repo: {
      ...fileRepo,
      path: repoPath,
      install_command: argvConfig("repo.install_command", file.repo.install_command, ["npm", "ci"]),
      test_command: testCommand(file.repo.test_command),
      ...checkCommandsConfig(rawChecks), ...uiCheckConfig(rawUiCheck), ...(rawRestart === undefined ? {} : { restart_command: argvConfig("repo.restart_command", rawRestart, ["bin/restart"]) }),
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
    ],
    agent_git_identity: file.agent_git_identity,
    budget_min_sample: budget.budget_min_sample,
    path_companions: pathCompanionsConfig(raw),
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

/** The configured repo as a local project: `local:local:<sha-256 of owner/name>`, labelled `local/owner/name`. */
export function localProject(repo: RepoRef): ProjectRef {
  const digest = createHash("sha256").update(`${repo.owner}/${repo.name}`).digest("hex").slice(0, 32);
  return { key: localProjectKey(digest), label: projectLabel("local", repo.owner, repo.name) };
}

/** The GitHub project key's resolution, for the CLI commands that resolve the key outside startup. */
export { resolveProject };

/** First wait between startup lookups while the configured repo's key is not known yet; it doubles up to the max. */
export const PROJECT_RETRY_MS = 30_000;
const PROJECT_RETRY_MAX_MS = 600_000;

/** A Forge.projectIdentity error retrying cannot fix (bad credentials, no such repository). Startup stops on it. */
function permanentLookupError(err: unknown): boolean {
  return (err as { permanent?: unknown } | null)?.permanent === true;
}

/** What startupProject needs: the store holding the key, the forge's read of it, and where to log and wait. */
export interface StartupProjectDeps {
  store: Pick<FactoryStore, "getCursor" | "advanceCursor" | "listSettingOverrides" | "listWorkItems">;
  /** The configured repo's project as the forge reports it now (Forge.projectIdentity). */
  identify: () => Promise<ProjectRef>;
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
    const refreshed = d.identify().then(
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
      const project = await d.identify();
      await saveProject(d.store, d.repo, project);
      return { project, refreshed: Promise.resolve() };
    } catch (err) {
      if (permanentLookupError(err)) throw err;
      d.log.warn("the configured repo's project key is not stored yet and GitHub cannot resolve it; retrying", {
        repo: `${d.repo.owner}/${d.repo.name}`, retry_in_ms: wait, error: errorText(err),
      });
    }
    await d.clock.sleep(wait, d.signal);
  }
}

/** What projectAtStartup reads the key through: the selected forge, or a test's stand-in for its GitHub client. */
interface ProjectSource { forge: Forge | null; repoLookup?: RepoLookup | undefined }

/**
 * The configured repo's key at startup (design 08-plugins). No GitHub plugin selected: the local project, stored as
 * the configured repo's key (#350's cursor) with no forge call. A forge that names its repository
 * (Forge.projectIdentity): startupProject through it. A GitHub plugin but no such forge: the stored key, else the
 * local one, with no forge call. Never a GitHub client call here.
 */
async function projectAtStartup(loaded: Loaded, src: ProjectSource, d: Omit<StartupProjectDeps, "identify">): Promise<{ project: ProjectRef; refreshed: Promise<void> }> {
  const { forge, repoLookup } = src;
  const identify = repoLookup ? () => resolveProject(repoLookup, d.repo) : forge?.projectIdentity ? () => forge.projectIdentity!() : null;
  const solo = loaded.config.local_only === true;
  if (!solo && identify !== null) return startupProject({ ...d, identify });
  const project = (solo ? null : await storeProjectResolver(d.store, d.repo)()) ?? localProject(d.repo);
  await saveProject(d.store, d.repo, project);
  return { project, refreshed: Promise.resolve() };
}

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
  // PR events, facts, comments and status (issue #273), else null; with no forge, the local forge reads links (forgeRoles).
  const selected = await p.forge(github, { store, clock, log: new ConsoleLogger(clock, "forge"), credentials });
  const { forge, links } = forgeRoles(selected, selected ?? (await createPlugin(registry, "forge", "local", { ...base, github })));
  // Identity (RFC 0015 §8, M9): service and run passports, and the audit of every authorize decision.
  const identity = await startProcessIdentity(loaded, store, clock);
  // Every person's command, whatever its origin, by the one owner check, one authz_audit row per decision (passport `none`).
  const auth = new OwnerAuth(store);
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
  // G2 with run passports and pack tool approvals (#592): every broker the worker pool or an agent's granted tools reach checks both.
  const packTools = packToolBrokers(loaded.pack_tools, tool_grants, { db: storeSql(store), store, secrets, autoApproveReadOnly: loaded.config.packs_auto_approve_read_only === true });
  const passports = new RunPassports(identity.passports);
  const guard = (b: ToolBroker): ToolBroker => new PassportToolBroker(packTools(b), { checker: identity.passports, passportOf: (run) => passports.passportOf(run) });
  const local = { ...unguardedLocal, broker: guard(unguardedLocal.broker) };
  const guarded = guard(broker);
  const runner = await p.runner(sandbox, secrets, { broker: guarded, scanner });
  const granted = [...new Set(Object.values(tool_grants ?? {}).flat())];
  if (granted.length > 0 && !runner.exposes_tools) {
    throw new Error(`tool_grants grants ${granted.join(", ")}, but the ${selectedRunners(sel).join(", ")} agent runner cannot expose broker tools; remove tool_grants or pick a runner that can`);
  }
  const storage = await createPlugin(registry, "storage", sel.storage, base);
  const awake = await createPlugin(registry, "awake", sel.awake, { ...base, clock });
  // list-all lists the packs' skills (design 11-packs.md); with none it finds nothing and the prompt gets no index.
  const capability = await createPlugin(registry, "capability", sel.capability, { ...base, capabilities: packSkills(loaded.packs) });
  // The network pause's probe (design §5 Restarts): only the endpoints of the plugins selected above.
  const network_probe = await createPlugin(registry, "network_probe", sel.network_probe, base);
  // The bus and the tick generators the roles run on (RFC 0015 §5, design 10-event-driven).
  const bus = await createPlugin(registry, "bus", sel.bus, base);
  const ticks = await createPlugin(registry, "ticks", sel.ticks, base);
  const tacit = await LiveTacit.start(sel.tacit, (name) => createPlugin(registry, "tacit", name, base), new ConsoleLogger(clock, "tacit"));
  const calendars = new LiveCalendars(async (name) => createPlugin(registry, "calendar", name, { ...base, secrets: await new Plugins({ ...loaded, plugins: { ...sel, calendars: [name] } }).secrets(), clock }), new ConsoleLogger(clock, "calendar"));
  // The worker's ExecutionEngine (RFC 0015 §7): one per worker loop, built by the pool.
  const engines = await createPlugin(registry, "engine", sel.engine, { ...base, store });
  // Startup resolution (design 2026-11-07), after every plugin check so a bad selection is reported first: the
  // project key every write uses, from the store; GitHub refreshes the label in the background (a rename). With
  // no GitHub plugin: the local project key, and no GitHub call.
  const { project, refreshed } = await projectAtStartup(loaded, { forge, repoLookup: opts.repoLookup }, {
    store, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup"), ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const config: FactoryConfig = { ...resolvedConfig(loaded.config, project), ...(tool_grants ? { tool_grants } : {}) };
  // The pack checks `hooks` names (design §4, issue #494), refused here when bad; its other names are `*.hook.ts`.
  const checks = packChecks(loaded.packs, config.hooks ?? [], { toolHooks: runner.supports_tool_hooks === true });
  await checkEnabledHooks((config.hooks ?? []).filter((n) => !checks.some((c) => c.name === n)));
  shareGitHubBudget(loaded, github, store, config);

  // Runtime overrides (design 2026-11-03) and learned values (08-settings): one cache of file values, stored overrides
  // and learned values, shared by the controller and the worker pool, refreshed each tick. Project blocks: by project key.
  const learned = new StoredLearnedSettings(store, new ConsoleLogger(clock, "settings"));
  const settings = new LiveSettings({
    config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, learned,
    log: new ConsoleLogger(clock, "settings"), integrations: [tacit], calendar: calendars, // the live `calendar` list (design 08-settings)
  });
  await settings.refresh();

  const controller = new ControllerRole({
    store,
    sources, forge, links,
    auth,
    service_auth: controllerServiceAuth(identity.passports),
    outbound_auth: outboundServiceAuth(identity.passports),
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
    llm,
    calendar: calendars.feeds, // synced every 5 minutes (design 02-tasks); [] unless the `calendar` setting lists some
    network_probe, bus, ticks, tacit, // tacit: the owner's ledger (#570), whose capture CLI outbound runs; no agent run gets it
    // Owner of a stream source's listener lease while this process holds it (docs/architecture.md, Intake).
    replica_id: `${hostname()}:${process.pid}`,
    // The factory repo's git writes under this machine's stable host id; a SQLite store (solo) flushes every host's.
    git_host: gitHost(stateDir, sel.store),
    settings, learned,
    // The worker pool's sandbox: the controller's local merge check fetches and checks through it (design §5).
    sandbox, repo_entries: async (names) => (await Promise.all(names.map((n) => stat(join(config.repo.path, n)).then(() => [n], () => [])))).flat(), // the merge reply's run hint
    // The alarm step's restart count (design 05-alarms): this host's supervisor status file.
    restarts: () => readRestarts(join(loaded.stateDir, SUPERVISOR_STATUS_FILE)),
    // This process's GitHub budget, stored after each poll for the status page (design §5, GitHub call budget).
    // With no GitHub plugin selected (Local startup) there is no GitHub client and no budget to record.
    // The shared budget is read before each tick's optional reads, at most once per tick.
    ...(loaded.config.local_only === true ? {} : { github_budget: () => github.status(), refresh_forge_budget: () => github.refreshSharedBudget() }),
    // The red-main check after an automatic merge (design 03-risk) runs the checks with the worker's base env.
    check_env: baseEnv(),
  });

  const id_prefix = `${hostname()}:${process.pid}`;
  const worker = new WorkerPool({
    id_prefix,
    // A run's push and PR go to this machine's git destination (`git:<host id>:<branch>`), which its controller flushes.
    host: hostId(stateDir),
    // The supervisor's block for this child (git-worktree updater); unset: 0.
    index_base: opts.workerIndexBase ?? workerIndexBase(process.env[WORKER_INDEX_BASE_ENV]),
    // The revision the supervisor built this child from, stamped on each run (`worker_runs.code_version`); unset: dev.
    ...codeVersion(process.env[CODE_VERSION_ENV]),
    store, sandbox, runner,
    broker: guarded, local, passports,
    scanner, storage, llm,
    clock, config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(), host_exec: runProcess, // the restart run's command, on the host in the base checkout (design 04-gate-commands)
    // Split over the runs running on this host at each claim as SF_TEST_WORKERS, so parallel test runs do not each take every CPU.
    cpus: availableParallelism(),
    models: { table: loaded.model_by, names: loaded.models },
    awake, capability, guidance: joinGuidance([new PackGuidance(loaded.packs), new LearnedRules(tacit)]), // packs' rules, then promoted rules (design 07)
    settings, learned,
    engines,
    ticks,
    pack_checks: new PackCheckRunner(checks, { sandbox, audit: new SqlHookAudit(storeSql(store)), now: () => clock.now().toISOString() }),
    // A run's PR comment is a thread entry on this ref; outbound posts it (RFC 0015 M7).
    ...(forge ? { prRef: (pr: number) => forge.prRef(pr) } : {}),
    // Imported MCP servers (design 11-plugin-import): never started for a run (owner answer 1); an approved one's
    // tools are listed here, in the worker, once per request, with an empty env and no credential (owner answer 3).
    imported_mcp_refusals: (servers) => importedMcpRefusals(storeSql(store), servers),
    list_mcp_tools: () => listRequestedMcpTools({ db: storeSql(store), now: () => clock.now().toISOString(), by: id_prefix, start: startPackMcpServer }),
  });

  return { loaded, clock, store, secrets, project, controller, worker, close: () => refreshed.then(() => identity.stop()).then(() => store.close()) };
}

/** This process's Identity on the store's database, its key in the state folder (denied to agents). */
export async function startProcessIdentity(loaded: Loaded, store: FactoryStore, clock: Clock): Promise<IdentityRuntime> {
  const log = new ConsoleLogger(clock, "identity");
  return startIdentity({
    db: storeSql(store),
    stateDir: loaded.stateDir,
    onError: (schedule, err) => log.error("identity tick failed", { step: schedule, error: errorText(err) }),
  });
}

/** `workers` from factory.config.json: absent means 1, otherwise an integer of 1 or more or startup fails. */
export { maxWorkers, workerCount };


/** `hooks` from factory.config.json: a list of hook names, or startup fails. */
export function hookNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("hooks must be a list of hook names");
  return value as string[];
}

/**
 * Every enabled hook name must be a discovered `*.hook.ts` at a point the factory calls: a typo, or a point no
 * caller runs yet, would otherwise leave the owner's check off without a word.
 */
export async function checkEnabledHooks(enabled: readonly string[], discovered?: readonly HookDescriptor[]): Promise<void> {
  if (enabled.length === 0) return;
  const known = new Map((discovered ?? (await loadHooks()).map((h) => h.descriptor)).map((h) => [h.name, h]));
  const missing = enabled.filter((n) => !known.has(n));
  if (missing.length > 0) throw new Error(`hooks: no discovered hook named ${missing.join(", ")}`);
  const unwired = enabled.filter((n) => UNCALLED_HOOK_POINTS.includes(known.get(n)!.point));
  if (unwired.length > 0) {
    throw new Error(`hooks: ${unwired.map((n) => `${n} (${known.get(n)!.point})`).join(", ")}: that point is not wired yet, so the hook would never run; remove it from hooks`);
  }
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
  displayNames: (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>; // by user id from Identity's identity_profiles (M9), only to show
  tacit: UiTacit; // the Rules page's ledger, switched by the `integrations` setting before each Rules request (design 08-settings)
  migrate: import("./ui/migrate-api.js").UiMigrate; // Migrate now, Start and Restart now (design 08-self-update): state dir, clock, run_timeout_ms, steps
  close(): Promise<void>;
}

/**
 * What the status page needs and nothing more: no controller, worker, source or runner, and no forge client.
 * Built through Plugins (the configured store, secrets and egress scanner). The secret store is loaded only because a store plugin may
 * declare secrets and the scanner needs the known secret values; neither reaches the page. The Settings page finds the configured repo's
 * project key from the stored project label (storeProjectResolver), so the UI process never calls the forge or reads a forge credential.
 * `identity` is the CLI identity main.ts resolves (cliIdentity); its user is the Settings writer, also of file-only keys (configWriter).
 * The CSRF token is made here, per process, and kept only in memory. The commands route acts as uiCommandsActor says and takes the same
 * token. The pause route's owner check uses the auth plugin over the local grants only, with a client that makes no forge call.
 */
export async function buildUiParts(loaded: Loaded, opts: { identity: CliIdentity }): Promise<UiParts> {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();
  const scanner = await p.scanner(secrets);
  const { owner, name } = loaded.config.repo, token = newCsrfToken();
  const settings: UiSettings = {
    base: settingsBase(loaded), repo: { owner, name }, actor: opts.identity.user, resolveProject: storeProjectResolver(store, { owner, name }), csrfToken: token,
    integrations: INTEGRATION_KINDS.map((kind) => ({ kind, interface: loaded.registry[kind].interface, configured: String(loaded.plugins[kind]) })),
  };
  // The owner check for "Resume now", approve_tool and the page's command checks (approve_spec, approve_merge), with no
  // forge call. Each command decision is audited (passport `none`); a page's read-only check only when refused (`check`).
  const identity = await startProcessIdentity(loaded, store, clock);
  const auth = new OwnerAuth(store);
  const onProject = async (user_id: UserId, action: AuthAction, readOnly = false): Promise<AuthDecision> => {
    const project = await settings.resolveProject();
    if (!project) return { allow: false, reason: "no project is stored yet" };
    return auth[readOnly ? "check" : "authorize"]({ user_id }, action, { kind: "project", id: project.key });
  };
  // One token per process for every write route; held only in memory, never written to a file, the store or a log.
  // The UI server, loaded here only: through setup.ts it reaches GitHub modules a solo start must not load.
  const who = uiCommandsActor(uiUserId(loaded.file.ui), opts.identity, (await import("./ui/server.js")).BIND);
  // The Merge button's facts (design §9): a forge selected, a sandbox that merges locally (built only to ask).
  const commands: UiCommands = {
    ...who, token, forge: loaded.plugins.forge !== undefined, localMerge: canMergeLocal(await p.sandbox()), changeName: (ref) => `PR #${ref}`, restart: loaded.config.repo.restart_command !== undefined,
    allowed: (action) => (who.actor === null ? Promise.resolve({ allow: false, reason: "no_actor" }) : onProject(who.actor, action, true)),
  };
  // The mode switch, the auto-merge tier and a loosening change need approve_merge on the project (design 08-settings), as the Merge button.
  settings.mayApproveMerge = async () => refusalOf(await onProject(opts.identity.user, "approve_merge"));
  settings.editFile = configWriter({ loaded, store, sandbox: await p.sandbox(), now: () => clock.now().toISOString(), actor: opts.identity.user, loadConfig, project: async () => (await settings.resolveProject())?.key ?? null });
  settings.calendar = (await import("./ui/calendar-api.js")).uiCalendar(loaded, {
    store, actor: settings.actor, clock, base: settings.base, connect: async (r) => (await import("./setup.js")).connectCalendar(r),
  }); // its Calendar section
  settings.ask = { llm: await p.llm(secrets).catch(() => null), log: new ConsoleLogger(clock, "ask") }; // the Data page's Ask: the Model plugin, null when it cannot be built
  const cliUser = cliUserConfig(loaded.file);
  const pauses: UiPauses = {
    // A local account linked to a factory user first, else `cli_user`: an ID, never a display name.
    principal: async () => (await auth.resolve({ provider: "local", subject: opts.identity.user.replace(/^local:/, "") }))?.user_id ?? cliUser,
    authorize: (user_id) => onProject(user_id, "approve_spec"),
    auth, // approve_tool for the pack approvals route (design 11-packs)
    csrfToken: token,
    log: new ConsoleLogger(clock, "ui"),
  };
  const profiles = new ProfileStore(storeSql(store)), displayNames = (ids: readonly string[]) => profiles.displayNames(ids);
  const tacit = await uiTacit(loaded.plugins.tacit, (n) => createPlugin(loaded.registry, "tacit", n, p.base), { config: loaded.config, base: settingsBase(loaded), source: store, log: new ConsoleLogger(clock, "tacit") });
  const migrate = (await import("./ui/migrate-api.js")).uiMigrate({ stateDir: loaded.stateDir, clock, runTimeoutMs: loaded.config.run_timeout_ms, githubApi: () => p.githubApi(), resolveProject }); // its GitHub client only for owner/name rows
  return { clock, store, scanner, settings, commands, pauses, displayNames, tacit, migrate, close: () => identity.stop().then(() => store.close()) };
}

const refusalOf = (d: AuthDecision): string | null => (d.allow ? null : d.reason);

/** The owner check, with no forge call: how a CLI command is authorized (approve_tool, `factory settings`, `factory resume`). */
export async function localAuth(_loaded: Loaded, store: FactoryStore): Promise<AuthProvider> {
  return new OwnerAuth(store);
}

/**
 * The owner check of every CLI command that asks one (approve_merge for a `factory settings` or `mode` change, design 08-settings;
 * approve_spec for the sentence form, `factory resume` and `factory workers`): `user` on the configured project, no forge call.
 */
export function ownerRefusal(loaded: Loaded, store: FactoryStore, user: UserId, action: AuthAction): () => Promise<string | null> {
  const repo = loaded.config.repo;
  return async () => {
    const project = (await storeProjectResolver(store, repo)()) ?? (loaded.config.local_only ? localProject(repo) : null);
    if (!project) return "no project key is stored yet; start the factory once first";
    return refusalOf(await (await localAuth(loaded, store)).authorize({ user_id: user }, action, { kind: "project", id: project.key }));
  };
}

export type { CliEnvironment, CliIdentity, FactoryStore }; // for the CLI component (src/cli/command.ts)

/** What `factory session` needs (design §5, 2026-11-01): no controller, worker, source or agent runner. `local` and `learned` as the worker pool's (Plugins.localRoute; 08-settings). */
export interface SessionParts {
  clock: Clock; store: FactoryStore; scanner: EgressScanner; sandbox: Sandbox; broker: ToolBroker; auth: AuthProvider; github: GitHubApi; config: FactoryConfig;
  local: LocalRoute; learned: LearnedSettingsSource;
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
  const auth = new OwnerAuth(store);
  const brokerDeps: BrokerDeps = { github, credentials, secrets, store, scanner, clock };
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, ...brokerDeps });
  const local = await p.localRoute({ broker, sandbox }, brokerDeps);
  const forge = await p.forge(github);
  const { project, refreshed } = await projectAtStartup(loaded, { forge }, { store, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup") });
  const config = resolvedConfig(loaded.config, project);
  shareGitHubBudget(loaded, github, store, config);
  const log = new ConsoleLogger(clock, "settings"), learned = new StoredLearnedSettings(store, log);
  const settings = new LiveSettings({ config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, learned, log });
  await settings.refresh();
  return { clock, store, scanner, sandbox, broker, local, auth, github, learned, config: settings.config(), close: () => refreshed.then(() => store.close()) };
}

/**
 * The configured store for `factory stats`, and nothing else. Unlike build() and buildUiParts() it never
 * calls migrate(): stats writes nothing, not even a schema change. The secret store is loaded only because a store plugin may declare secrets.
 */
export async function buildStatsStore(loaded: Loaded): Promise<FactoryStore> {
  const p = new Plugins(loaded);
  const clock = await p.clock();
  return p.store(await p.secrets(), clock);
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
  const caches = readOnlyFolders("toolchain.caches", raw.caches ?? [], { expand: expandHome(ctx.home), deny_paths: ctx.deny_paths }, problems);
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

/** A configured path with a leading `~` taken as the owner's HOME (no HOME: unchanged, so it fails as relative). */
const expandHome = (home: string) => (p: string): string => ((p === "~" || p.startsWith("~/")) && home !== "" ? join(home, p.slice(1)) : p);

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

function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

export { Plugins } from "./plugin-set.js";
export { settingsBase } from "./core/settings-base.js";
