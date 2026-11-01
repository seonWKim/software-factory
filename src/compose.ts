// Composition root: the only place that reads env/files for config and picks implementations.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FactoryConfig, LoadedConfig, Prompts, StatsConfig } from "./core/config.js";
import { type ProjectRef, githubProjectKey, projectLabel, rekeyProjectSettings } from "./core/project.js";
import { saveProjectLabel } from "./core/project-labels.js";
import type { Tier, VerdictSeverity } from "./core/types.js";
import { budgetConfig } from "./core/budget.js";
import { type ModelNames, type ModelTable, parseModelBy, parseModels } from "./core/model-choice.js";
import { Controller } from "./core/controller.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";
import { settingsLayers } from "./core/settings.js";
import { WorkerPool } from "./core/worker-pool.js";
import { checkConfigKeys } from "./config-keys.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubCredentials } from "./interfaces/github-credentials.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";
import { GitHubClient, type RepoIdentity, type RepoRef } from "./impl/github/github-client.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import { baseEnv } from "./impl/process/run-process.js";
import { DEFAULT_STATUS_LABEL_PREFIX } from "./impl/source/github-issue-source.js";
import { defaultSecretsFile, readEnvSettings } from "./impl/secrets/env-file-secret-store.js";
import { type BaseContext, REGISTRY, type Registry, type Selection, createPlugin, selectPlugins, selectedSources } from "./plugins.js";

/** SQLite: one machine. MySQL: any number of controllers and workers on any hosts (architecture §4). */
export type StoreConfig =
  | { type: "sqlite" }
  | { type: "mysql"; host: string; port: number; database: string; user: string };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  /** install_command, test_command: argv, defaults ["npm", "ci"] and ["npm", "test"]. */
  repo: { owner: string; name: string; path: string; base_branch: string; install_command?: unknown; test_command?: unknown };
  intake_label: string;
  /** Prefix of the status labels (docs/plugins.md, SourceAdapter). Absent: "sf: ". */
  status_label_prefix?: string;
  branch_prefix: string;
  dials: { spec_gate_min_tier: number; auto_merge_max_tier: number };
  /** Human floors (design §3). A per-project setting: may move into `defaults`, and a project may add to it. */
  floors?: { prefix: string; tier: number }[];
  /** AuthProvider plugin name (docs/plugins.md). */
  auth: string;
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
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  /** Stream intake: days an inbox row is kept once behind its cursor. Absent: 14. Positive integer. */
  inbox_retention_days?: number;
  /** Worker loops per `dev` / `worker` process (architecture §4). Absent: 1. */
  workers?: unknown;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
  /** The read-only status page (`factory ui`). Always bound to 127.0.0.1; there is no host option. */
  ui?: { port?: number };
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
}

export { CODE_ROOT_ENV, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";

export interface Loaded {
  /** The state root: the main checkout. State dir, worktrees, repo path and the database resolve here. */
  root: string;
  /** Where factory.config.json and prompts/ were read: the runtime copy under the updater, else `root`. */
  codeRoot: string;
  file: FileConfig;
  /** Not yet resolved to a project key: build() resolves the configured repo through GitHub (resolveProject). */
  config: LoadedConfig;
  prompts: Prompts;
  secretsFile: string;
  stateDir: string;
  store: StoreConfig;
  /** Checked plugin name per interface. */
  plugins: Selection;
  /** Where plugin names resolve. The built-in REGISTRY unless a test passes another. */
  registry: Registry;
  /** The checked `stats` key. Read only by `factory stats`; no dial uses it. */
  stats: StatsConfig;
  /** The checked `models`: a model name for cheap, standard and strong. */
  models: ModelNames;
  /** The checked, expanded `model_by` (the default table when absent). */
  model_by: ModelTable;
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
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error("heartbeat_ms must be well under lease_ms");
  uiPort(file.ui);
  const workers = workerCount(file.workers);
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
  const secretsFile = defaultSecretsFile();
  const store = await storeConfig(baseStore, secretsFile);

  const stateDir = resolve(root, file.state_dir);
  const home = process.env.HOME ?? "";
  const config: LoadedConfig = {
    repo: {
      ...file.repo,
      path: resolve(root, file.repo.path),
      install_command: argvConfig("repo.install_command", file.repo.install_command, ["npm", "ci"]),
      test_command: testCommand(file.repo.test_command),
    },
    intake_label: file.intake_label,
    status_label_prefix: file.status_label_prefix ?? DEFAULT_STATUS_LABEL_PREFIX,
    branch_prefix: file.branch_prefix,
    dials: { spec_gate_min_tier: file.dials.spec_gate_min_tier as Tier, auto_merge_max_tier: 0 },
    settings,
    max_loops: file.max_loops,
    max_restart: retry.max_restart,
    retry_base_ms: retry.retry_base_ms,
    retry_max_ms: retry.retry_max_ms,
    lease_ms: file.lease_ms,
    heartbeat_ms: file.heartbeat_ms,
    tick_ms: file.tick_ms,
    poll_interval_ms: file.poll_interval_ms,
    run_timeout_ms: file.run_timeout_ms,
    inbox_retention_days: retention,
    workers,
    deny_paths: [
      dirname(secretsFile),
      join(stateDir, "db"),
      join(stateDir, "storage"),
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
  };
  const prompts: Prompts = {
    triage: await readFile(join(codeRoot, "prompts", "triage.md"), "utf8"),
    implement: await readFile(join(codeRoot, "prompts", "implement.md"), "utf8"),
    review: await readFile(join(codeRoot, "prompts", "review.md"), "utf8"),
  };
  const resolvePrompt = await readFile(join(codeRoot, "prompts", "resolve.md"), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (resolvePrompt !== undefined) prompts.resolve = resolvePrompt;
  return { root, codeRoot, file, config, prompts, secretsFile, stateDir, store, plugins, registry, stats, models, model_by };
}

/** What startup resolution needs from the GitHub client: one read of the repository. */
export interface RepoLookup {
  repoIdentity(repo: RepoRef): Promise<RepoIdentity>;
}

/**
 * The configured repo as a project (design 2026-11-01): its key from GitHub's node ID, its label from the path
 * GitHub reports now (a renamed repo gets its new path). Throws a message naming the configured repo and the
 * reason when GitHub cannot resolve it; the process then exits with that message instead of writing anything.
 */
export async function resolveProject(github: RepoLookup, repo: RepoRef): Promise<ProjectRef> {
  try {
    const id = await github.repoIdentity(repo);
    return { key: githubProjectKey(id.host, id.node_id), label: projectLabel(id.host, id.owner, id.name) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot resolve the configured repo ${repo.owner}/${repo.name} (factory.config.json repo.owner / repo.name) to its GitHub repository ID: ${reason}`,
    );
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
  /** The configured repo, resolved at startup. */
  project: ProjectRef;
  controller: Controller;
  /** `config.workers` worker loops; `run(signal)` runs them all. */
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
  llm(secrets: SecretStore): Promise<LLMProvider> {
    return createPlugin(this.loaded.registry, "llm", this.loaded.plugins.llm, { ...this.base, secrets });
  }
  sandbox(): Promise<Sandbox> {
    return createPlugin(this.loaded.registry, "sandbox", this.loaded.plugins.sandbox, this.base);
  }
  githubCredentials(secrets: SecretStore, clock: Clock): Promise<GitHubCredentials> {
    return createPlugin(this.loaded.registry, "github_auth", this.loaded.plugins.github_auth, { ...this.base, secrets, clock });
  }
  runner(sandbox: Sandbox, secrets: SecretStore) {
    return createPlugin(this.loaded.registry, "runner", this.loaded.plugins.runner, { ...this.base, sandbox, secrets });
  }
}

export async function build(
  loaded: Loaded,
  opts: { clock?: Clock; extraScanValues?: string[]; workerIndexBase?: number; repoLookup?: RepoLookup } = {},
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
  const github = new GitHubClient(credentials);
  const sandbox = await p.sandbox();

  // One adapter per listed source; the controller routes each item to the one of its source type.
  const sources = [];
  for (const name of selectedSources(sel)) sources.push(await createPlugin(registry, "source", name, { ...base, github }));
  const auth = await createPlugin(registry, "auth", sel.auth, { ...base, github });
  // Suggests a command for a plain-language comment; never changes state (design §4).
  const llm = await p.llm(secrets);
  const runner = await p.runner(sandbox, secrets);
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, github, credentials, secrets, store, scanner, clock });
  const storage = await createPlugin(registry, "storage", sel.storage, base);
  const awake = await createPlugin(registry, "awake", sel.awake, { ...base, clock });
  // list-all has no source for its capabilities yet, so it finds nothing and the prompt gets no index.
  const capability = await createPlugin(registry, "capability", sel.capability, { ...base, capabilities: [] });

  // Startup resolution (design 2026-11-01), after every plugin check so a bad selection is reported first: the
  // project key every write uses, and the label refreshed from GitHub (a renamed repo shows its new path).
  const project = await resolveProject(opts.repoLookup ?? github, base.repo);
  await saveProjectLabel(store, project);
  const config = resolvedConfig(loaded.config, project);

  const controller = new Controller({
    store,
    sources,
    auth,
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
    llm,
    // Owner of a stream source's listener lease while this process holds it (docs/architecture.md, Intake).
    replica_id: `${hostname()}:${process.pid}`,
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
  });

  return { loaded, clock, store, secrets, project, controller, worker, close: () => store.close() };
}

/** `workers` from factory.config.json: absent means 1, otherwise an integer of 1 or more or startup fails. */
export function workerCount(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`workers must be an integer of 1 or more (got ${JSON.stringify(value) ?? String(value)})`);
  }
  return value;
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

export interface UiParts {
  clock: Clock;
  store: FactoryStore;
  scanner: EgressScanner;
  close(): Promise<void>;
}

/**
 * What the status page needs and nothing more: no controller, worker, source or runner. Built through
 * Plugins (the configured store, secrets and egress scanner). The secret store is loaded only because the
 * MySQL store needs MYSQL_PASSWORD and the scanner needs the known secret values; neither reaches the page.
 */
export async function buildUiParts(loaded: Loaded): Promise<UiParts> {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();
  const scanner = await p.scanner(secrets);
  return { clock, store, scanner, close: () => store.close() };
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
