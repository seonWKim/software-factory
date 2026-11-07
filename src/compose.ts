// Composition root: the only place that reads env/files for config and picks implementations.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type FactoryConfig, type LoadedConfig, type Prompts, STALL_DEFAULTS, type StatsConfig, coordinationConfig, toolGrantsConfig } from "./core/config.js";
import { type ProjectRef, githubProjectKey, projectLabel, rekeyProjectSettings } from "./core/project.js";
import { pathCompanionsConfig } from "./core/companions.js";
import { checkCommands, commandText } from "./core/checks.js";
import { saveProject, saveProjectLabel } from "./core/project-labels.js";
import type { Logger } from "./core/log.js";
import type { Tier, UserId, VerdictSeverity } from "./core/types.js";
import { budgetConfig } from "./core/budget.js";
import { type ModelNames, type ModelTable, parseModelBy, parseModels } from "./core/model-choice.js";
import { Controller } from "./core/controller.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";
import {
  type GlobalSettableKey, HEARTBEAT_LEASE_MESSAGE, booleanSetting, LiveSettings, SETTABLE_KEYS, type SettingsBase, isProjectSettableKey, maxWorkers, settingsLayers, workerCount,
} from "./core/settings.js";
import { WorkerPool } from "./core/worker-pool.js";
import { FallbackLLM } from "./core/fallback-llm.js";
import { FallbackRunner } from "./core/fallback-runner.js";
import { checkConfigKeys } from "./config-keys.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubCredentials } from "./interfaces/github-credentials.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Forge } from "./interfaces/forge.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { AuthProvider } from "./interfaces/auth-provider.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";
import { autoMigrate } from "./impl/updater/auto-migrate.js";
import { GitHubClient, type GitHubClientOptions, GitHubError, type RepoIdentity, type RepoRef, githubMinRemaining } from "./impl/github/github-client.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import type { UiCommands } from "./ui/commands.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "./ui/settings-api.js";
import type { OpenAICompatibleConfig } from "./impl/openai/config.js";
import { baseEnv } from "./impl/process/run-process.js";
import { DEFAULT_STATUS_LABEL_PREFIX } from "./impl/source/github-issue-source.js";
import { defaultSecretsFile, readEnvSettings } from "./impl/secrets/env-file-secret-store.js";
import {
  type BaseContext, GRANTS, REGISTRY, type Registry, type Selection, createGrants, createPlugin, selectGrants, selectPlugins, selectedLlms, selectedLocalAuth, selectedRunners, selectedSources,
} from "./plugins.js";

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
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Stream intake: days an inbox row is kept once behind its cursor. Absent: 14. Positive integer. */
  inbox_retention_days?: number;
  /** Worker loops per `dev` / `worker` process (architecture §4). Absent: 1. */
  workers?: unknown;
  /** Worker slots per process, the most the live `workers` setting can reach. Absent: `workers`. */
  max_workers?: unknown;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
  /**
   * The status page (`factory ui`). Always bound to 127.0.0.1; there is no host option. `user_id`: the factory
   * user ID the page's commands act as (issue #227); absent, the page cannot send commands.
   */
  ui?: { port?: number; user_id?: string };
  /** The git-worktree updater: `auto_migrate` (default false) runs `npm run migrate` itself between drain and start. */
  updater?: { auto_migrate?: unknown };
  /** The GitHub client: `min_remaining` (default 200), the rate-limit floor under which optional reads wait for the reset. */
  github?: { min_remaining?: unknown };
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
   * Path companions (design 04-triage.md): a list of `{ when, also }`. When triage's `files_to_change` names
   * `when`, each `also` path is added to `allowed_paths`. Absent: none. Checked by pathCompanionsConfig.
   */
  path_companions?: unknown;
}

export { CODE_ROOT_ENV, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";

export interface Loaded {
  /** The state root: the main checkout. State dir, worktrees, repo path and the database resolve here. */
  root: string;
  /** Where factory.config.json and prompts/ were read: the runtime copy under the updater, else `root`. */
  codeRoot: string;
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

/**
 * A prompt file's text with the check-commands placeholder filled, once at load: each command of `checkCommands`
 * (so `repo.check_commands`, else `test_command`) in backticks, in order.
 */
export function fillPrompt(text: string, repo: FactoryConfig["repo"]): string {
  const checks = checkCommands(repo).map((c) => `\`${commandText(c)}\``).join(", then ");
  return text.split(CHECK_COMMANDS_PLACEHOLDER).join(checks);
}

/**
 * `codeRoot` is where config and prompts are read (the updater's runtime copy); `root` is where state lives.
 * `platform` picks the platform-dependent plugin defaults (docs/plugins.md); the host's unless a test passes one.
 */
export async function loadConfig(
  root = process.cwd(),
  opts: { registry?: Registry; codeRoot?: string | undefined; platform?: string | undefined } = {},
): Promise<Loaded> {
  const codeRoot = resolve(opts.codeRoot ?? root);
  const raw: unknown = JSON.parse(await readFile(join(codeRoot, "factory.config.json"), "utf8"));
  checkConfigKeys(raw);
  const file = raw as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error("auto_merge_max_tier must be 0: auto-merge is not implemented, and loosening is a human decision");
  }
  if (!isTier(file.dials.spec_gate_min_tier)) {
    throw new Error("tiers must be integers 1–5");
  }
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error(HEARTBEAT_LEASE_MESSAGE);
  uiPort(file.ui);
  uiUserId(file.ui);
  autoMigrate(file.updater);
  githubMinRemaining(file.github);
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
  const plugins = selectPlugins(registry, { store: baseStore, auth: file.auth, plugins: file.plugins }, { platform: opts.platform });
  const grants = selectGrants(GRANTS, file.permissions);
  const secretsFile = defaultSecretsFile();
  const store = await storeConfig(baseStore, secretsFile);

  const stateDir = resolve(root, file.state_dir);
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
    inbox_retention_days: retention,
    workers,
    max_workers,
    deny_paths: [
      dirname(secretsFile),
      join(stateDir, "db"),
      join(stateDir, "storage"),
      // The owner's test MySQL login (SET_UP.md): agents may connect to localhost since the sandbox allows it.
      join(stateDir, "test-mysql.url"),
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
  const readPrompt = async (name: string): Promise<string> => fillPrompt(await readFile(join(codeRoot, "prompts", `${name}.md`), "utf8"), config.repo);
  const prompts: Prompts = {
    triage: await readPrompt("triage"),
    implement: await readPrompt("implement"),
    review: await readPrompt("review"),
  };
  const resolvePrompt = await readPrompt("resolve").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (resolvePrompt !== undefined) prompts.resolve = resolvePrompt;
  return { root, codeRoot, file, config, prompts, secretsFile, stateDir, store, plugins, registry, grants, stats, models, model_by };
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
  controller: Controller;
  /** `config.max_workers` worker slots, `workers` of them claiming; `run(signal)` runs them all. */
  worker: WorkerPool;
  close(): Promise<void>;
}

/**
 * Resolves the configured plugins one at a time, through the same registry as build(). For code that needs
 * only some of them: setup, doctor and the G6 canary, so they exercise the configured guards.
 */
export class Plugins {
  readonly base: BaseContext;

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
  githubCredentials(secrets: SecretStore, clock: Clock): Promise<GitHubCredentials> {
    return createPlugin(this.loaded.registry, "github_auth", this.loaded.plugins.github_auth, { ...this.base, secrets, clock });
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
   * The selected forge (`plugins.forge`, issue #172), or null when config selects none: then nothing is built.
   * Optional and not yet used by build(): the controller still reads PR facts from its sources.
   */
  async forge(github: GitHubClient): Promise<Forge | null> {
    const name = this.loaded.plugins.forge;
    return name === undefined ? null : createPlugin(this.loaded.registry, "forge", name, { ...this.base, github });
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
  const credentials = await p.githubCredentials(secrets, clock);
  const github = new GitHubClient(credentials, undefined, githubClientOptions(loaded, clock));
  const sandbox = await p.sandbox();

  // One adapter per listed source; the controller routes each item to the one of its source type.
  const sources = [];
  for (const name of selectedSources(sel)) sources.push(await createPlugin(registry, "source", name, { ...base, github, store }));
  // Grant sources first: the auth plugin's authorize asks them (src/core/authorize.ts, design 2026-11-01).
  const grants = await createGrants(GRANTS, loaded.grants, { ...base, github });
  const auth = await createPlugin(registry, "auth", sel.auth, { ...base, github, store, grants });
  // Local commands (CLI, local UI) by their own auth plugin, `local` by default (issue #318): never GitHub's.
  const local_auth = await createPlugin(registry, "auth", selectedLocalAuth(sel), { ...base, github, store, grants });
  // Suggests a command for a plain-language comment; never changes state (design §4).
  const llm = await p.llm(secrets);
  // The broker before the runner: the runner exposes granted broker tools through it (`tool_grants`).
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, github, credentials, secrets, store, scanner, clock });
  // Checked here, not in loadConfig: the broker's tool list comes from its plugin. Read-only tools only.
  const tool_grants = toolGrantsConfig(loaded.file.tool_grants, broker, sel.broker);
  const runner = await p.runner(sandbox, secrets, { broker, scanner });
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

  // Startup resolution (design 2026-11-07), after every plugin check so a bad selection is reported first: the
  // project key every write uses, from the store; GitHub refreshes the label in the background (a rename).
  const { project, refreshed } = await startupProject({
    store, lookup: opts.repoLookup ?? github, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup"), ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const config: FactoryConfig = { ...resolvedConfig(loaded.config, project), ...(tool_grants ? { tool_grants } : {}) };

  // Runtime overrides (design 2026-11-03): one cache of file values plus stored overrides, shared by the
  // controller and the worker pool, refreshed each tick. The file's per-project blocks are keyed by project key.
  const settings = new LiveSettings({
    config,
    base: { ...settingsBase(loaded), layers: config.settings },
    source: store,
    log: new ConsoleLogger(clock, "settings"),
  });
  await settings.refresh();

  const controller = new Controller({
    store,
    sources,
    auth,
    local_auth,
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
    llm,
    // Owner of a stream source's listener lease while this process holds it (docs/architecture.md, Intake).
    replica_id: `${hostname()}:${process.pid}`,
    settings,
    // The worker pool's sandbox: the controller's local merge check fetches and checks through it (design §5).
    sandbox,
  });

  const worker = new WorkerPool({
    id_prefix: `${hostname()}:${process.pid}`,
    // The supervisor's block for this child (git-worktree updater); unset: 0.
    index_base: opts.workerIndexBase ?? workerIndexBase(process.env[WORKER_INDEX_BASE_ENV]),
    store,
    sandbox,
    runner,
    broker,
    scanner,
    storage,
    clock,
    config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(),
    models: { table: loaded.model_by, names: loaded.models },
    awake,
    capability,
    testDatabase,
    settings,
  });

  return { loaded, clock, store, secrets, project, controller, worker, close: () => refreshed.then(() => store.close()) };
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
 * `ui.user_id` from factory.config.json: absent means null (the page cannot send commands), otherwise a
 * non-empty string (a factory user ID, never a display name) or startup fails naming the key.
 */
export function uiUserId(ui: FileConfig["ui"]): UserId | null {
  const id: unknown = ui?.user_id;
  if (id === undefined) return null;
  if (typeof id !== "string" || id.trim() === "") throw new Error("ui.user_id must be a non-empty string (a factory user ID)");
  return id.trim() as UserId;
}

export interface UiParts {
  clock: Clock;
  store: FactoryStore;
  scanner: EgressScanner;
  /** The Settings page's write path (design §8, issue #236): the config base, repo, actor, store-only resolver, CSRF token. */
  settings: UiSettings;
  /** The item commands route (POST /api/v1/items/:id/commands, issue #227): ui.user_id and the per-process token. */
  commands: UiCommands;
  close(): Promise<void>;
}

/**
 * What the status page needs and nothing more: no controller, worker, source or runner, and no forge client.
 * Built through Plugins (the configured store, secrets and egress scanner). The secret store is loaded only
 * because the MySQL store needs MYSQL_PASSWORD and the scanner needs the known secret values; neither reaches
 * the page. The Settings page finds the configured repo's project key from the stored project label
 * (storeProjectResolver), so the UI process never calls the forge or reads a forge credential. `actor` is the
 * writer's ID (`local:<OS login>`); the CSRF token is made here, per process, and kept only in memory. The
 * commands route acts as `ui.user_id` (null: not configured) and takes the same token.
 */
export async function buildUiParts(loaded: Loaded, opts: { actor: string }): Promise<UiParts> {
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
    actor: opts.actor,
    resolveProject: storeProjectResolver(store, { owner, name }),
    csrfToken: token,
  };
  // One token per process for both write routes; held only in memory, never written to a file, the store or a log.
  const commands: UiCommands = { actor: uiUserId(loaded.file.ui), token };
  return { clock, store, scanner, settings, commands, close: () => store.close() };
}

/** What `factory session` needs (design §5, 2026-11-01): no controller, worker, source or agent runner. */
export interface SessionParts {
  clock: Clock; store: FactoryStore; scanner: EgressScanner; sandbox: Sandbox; broker: ToolBroker; auth: AuthProvider; github: GitHubClient; config: FactoryConfig;
  close(): Promise<void>;
}

/** The GitHub client's settings from factory.config.json (`github`), with its log lines under "github". */
function githubClientOptions(loaded: Loaded, clock: Clock): GitHubClientOptions {
  return { clock, log: new ConsoleLogger(clock, "github"), min_remaining: githubMinRemaining(loaded.file.github) };
}

/** build()'s parts a session uses, through the same registry; the broker is its only push and PR path. Live settings. */
export async function buildSessionParts(loaded: Loaded): Promise<SessionParts> {
  const { stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const [base, clock, secrets] = [p.base, await p.clock(), await p.secrets()];
  const store = await p.store(secrets, clock);
  await store.migrate();
  const [scanner, credentials, sandbox] = [await p.scanner(secrets), await p.githubCredentials(secrets, clock), await p.sandbox()];
  const github = new GitHubClient(credentials, undefined, githubClientOptions(loaded, clock));
  const grants = await createGrants(GRANTS, loaded.grants, { ...base, github });
  const auth = await createPlugin(registry, "auth", sel.auth, { ...base, github, store, grants });
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, github, credentials, secrets, store, scanner, clock });
  const { project, refreshed } = await startupProject({ store, lookup: github, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup") });
  const config = resolvedConfig(loaded.config, project);
  const settings = new LiveSettings({ config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, log: new ConsoleLogger(clock, "settings") });
  await settings.refresh();
  return { clock, store, scanner, sandbox, broker, auth, github, config: settings.config(), close: () => refreshed.then(() => store.close()) };
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
