// Composition root: the only place that reads env/files for config and picks implementations.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FactoryConfig, Prompts } from "./core/config.js";
import type { Tier, WorkerId } from "./core/types.js";
import { Controller } from "./core/controller.js";
import { Worker } from "./core/worker.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { GitHubClient } from "./impl/github/github-client.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import { baseEnv } from "./impl/process/run-process.js";
import { DEFAULT_STATUS_LABEL_PREFIX } from "./impl/source/github-issue-source.js";
import { defaultSecretsFile, readEnvSettings } from "./impl/secrets/env-file-secret-store.js";
import { type BaseContext, REGISTRY, type Registry, type Selection, createPlugin, selectPlugins } from "./plugins.js";

/** SQLite: one machine. MySQL: any number of controllers and workers on any hosts (architecture §4). */
export type StoreConfig =
  | { type: "sqlite" }
  | { type: "mysql"; host: string; port: number; database: string; user: string };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  /** test_command: argv, default ["npm", "test"]. */
  repo: { owner: string; name: string; path: string; base_branch: string; test_command?: unknown };
  intake_label: string;
  /** Prefix of the status labels (docs/plugins.md, SourceAdapter). Absent: "sf: ". */
  status_label_prefix?: string;
  branch_prefix: string;
  dials: { spec_gate_min_tier: number; auto_merge_max_tier: number };
  floors: { prefix: string; tier: number }[];
  /** AuthProvider plugin name (docs/plugins.md). */
  auth: string;
  /** Plugin name per interface (docs/plugins.md). Absent: today's defaults. Guards can never be disabled. */
  plugins?: Record<string, unknown>;
  models: { cheap: string; strong: string };
  max_loops: number;
  max_attempts: number;
  /** Infra failures of one step before it blocks on a human. Absent: 3. */
  max_restart?: number;
  /** First automatic retry wait; doubles each retry. Absent: 60000. */
  retry_base_ms?: number;
  /** Cap on a retry wait, and the rate-limit pause with no reset time. Absent: 1800000. */
  retry_max_ms?: number;
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
  /** The read-only status page (`factory ui`). Always bound to 127.0.0.1; there is no host option. */
  ui?: { port?: number };
}

export { CODE_ROOT_ENV } from "./interfaces/updater.js";

export interface Loaded {
  /** The state root: the main checkout. State dir, worktrees, repo path and the database resolve here. */
  root: string;
  /** Where factory.config.json and prompts/ were read: the runtime copy under the updater, else `root`. */
  codeRoot: string;
  file: FileConfig;
  config: FactoryConfig;
  prompts: Prompts;
  secretsFile: string;
  stateDir: string;
  store: StoreConfig;
  /** Checked plugin name per interface. */
  plugins: Selection;
  /** Where plugin names resolve. The built-in REGISTRY unless a test passes another. */
  registry: Registry;
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
  const file = JSON.parse(await readFile(join(codeRoot, "factory.config.json"), "utf8")) as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error("auto_merge_max_tier must be 0: auto-merge is not implemented, and loosening is a human decision");
  }
  if (!isTier(file.dials.spec_gate_min_tier) || !file.floors.every((f) => isTier(f.tier))) {
    throw new Error("tiers must be integers 1–5");
  }
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error("heartbeat_ms must be well under lease_ms");
  uiPort(file.ui);
  const retry = retryConfig(file);
  const registry = opts.registry ?? REGISTRY;
  const baseStore = file.store ?? { type: "sqlite" };
  const plugins = selectPlugins(registry, { store: baseStore, auth: file.auth, plugins: file.plugins }, { platform: opts.platform });
  const secretsFile = defaultSecretsFile();
  const store = await storeConfig(baseStore, secretsFile);

  const stateDir = resolve(root, file.state_dir);
  const home = process.env.HOME ?? "";
  const config: FactoryConfig = {
    repo: { ...file.repo, path: resolve(root, file.repo.path), test_command: testCommand(file.repo.test_command) },
    intake_label: file.intake_label,
    status_label_prefix: file.status_label_prefix ?? DEFAULT_STATUS_LABEL_PREFIX,
    branch_prefix: file.branch_prefix,
    dials: { spec_gate_min_tier: file.dials.spec_gate_min_tier as Tier, auto_merge_max_tier: 0 },
    floors: file.floors.map((f) => ({ prefix: f.prefix, tier: f.tier as Tier })),
    max_loops: file.max_loops,
    max_attempts: file.max_attempts,
    max_restart: retry.max_restart,
    retry_base_ms: retry.retry_base_ms,
    retry_max_ms: retry.retry_max_ms,
    lease_ms: file.lease_ms,
    heartbeat_ms: file.heartbeat_ms,
    tick_ms: file.tick_ms,
    poll_interval_ms: file.poll_interval_ms,
    run_timeout_ms: file.run_timeout_ms,
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
  };
  const prompts: Prompts = {
    triage: await readFile(join(codeRoot, "prompts", "triage.md"), "utf8"),
    implement: await readFile(join(codeRoot, "prompts", "implement.md"), "utf8"),
    review: await readFile(join(codeRoot, "prompts", "review.md"), "utf8"),
  };
  return { root, codeRoot, file, config, prompts, secretsFile, stateDir, store, plugins, registry };
}

export interface Built {
  loaded: Loaded;
  clock: Clock;
  store: FactoryStore;
  secrets: SecretStore;
  controller: Controller;
  worker: Worker;
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
  sandbox(): Promise<Sandbox> {
    return createPlugin(this.loaded.registry, "sandbox", this.loaded.plugins.sandbox, this.base);
  }
  runner(sandbox: Sandbox, secrets: SecretStore) {
    return createPlugin(this.loaded.registry, "runner", this.loaded.plugins.runner, { ...this.base, sandbox, secrets });
  }
}

export async function build(
  loaded: Loaded,
  opts: { clock?: Clock; extraScanValues?: string[] } = {},
): Promise<Built> {
  const { config, stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded, opts);
  const base = p.base;
  const clock = opts.clock ?? (await p.clock());
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();

  const scanner = await p.scanner(secrets);
  const github = new GitHubClient(secrets);
  const sandbox = await p.sandbox();

  const controller = new Controller({
    store,
    source: await createPlugin(registry, "source", sel.source, { ...base, github }),
    auth: await createPlugin(registry, "auth", sel.auth, { ...base, github }),
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
  });

  const worker = new Worker({
    id: `${hostname()}:${process.pid}` as WorkerId,
    store,
    sandbox,
    runner: await p.runner(sandbox, secrets),
    broker: await createPlugin(registry, "broker", sel.broker, { ...base, github, secrets, store, scanner, clock }),
    scanner,
    storage: await createPlugin(registry, "storage", sel.storage, base),
    clock,
    config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(),
    awake: await createPlugin(registry, "awake", sel.awake, { ...base, clock }),
    // list-all has no source for its capabilities yet, so it finds nothing and the prompt gets no index.
    capability: await createPlugin(registry, "capability", sel.capability, { ...base, capabilities: [] }),
  });

  return { loaded, clock, store, secrets, controller, worker, close: () => store.close() };
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
  if (value === undefined) return ["npm", "test"];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v !== "")) {
    throw new Error("repo.test_command must be a non-empty array of non-empty strings (argv), e.g. [\"npm\", \"test\"]");
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

function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}
