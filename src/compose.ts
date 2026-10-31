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
import { defaultSecretsFile, readEnvSettings } from "./impl/secrets/env-file-secret-store.js";
import { type BaseContext, REGISTRY, type Registry, type Selection, createPlugin, selectPlugins } from "./plugins.js";

/** SQLite: one machine. MySQL: any number of controllers and workers on any hosts (architecture §4). */
export type StoreConfig =
  | { type: "sqlite" }
  | { type: "mysql"; host: string; port: number; database: string; user: string };

export interface FileConfig {
  env: "local" | "cloud";
  store?: StoreConfig;
  repo: { owner: string; name: string; path: string; base_branch: string };
  intake_label: string;
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
  lease_ms: number;
  heartbeat_ms: number;
  tick_ms: number;
  poll_interval_ms: number;
  run_timeout_ms: number;
  state_dir: string;
  worktrees_dir: string;
  agent_git_identity: { name: string; email: string };
}

export interface Loaded {
  root: string;
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

export async function loadConfig(root = process.cwd(), opts: { registry?: Registry } = {}): Promise<Loaded> {
  const file = JSON.parse(await readFile(join(root, "factory.config.json"), "utf8")) as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error("auto_merge_max_tier must be 0: auto-merge is not implemented, and loosening is a human decision");
  }
  if (!isTier(file.dials.spec_gate_min_tier) || !file.floors.every((f) => isTier(f.tier))) {
    throw new Error("tiers must be integers 1–5");
  }
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error("heartbeat_ms must be well under lease_ms");
  const registry = opts.registry ?? REGISTRY;
  const baseStore = file.store ?? { type: "sqlite" };
  const plugins = selectPlugins(registry, { store: baseStore, auth: file.auth, plugins: file.plugins });
  const secretsFile = defaultSecretsFile();
  const store = await storeConfig(baseStore, secretsFile);

  const stateDir = resolve(root, file.state_dir);
  const home = process.env.HOME ?? "";
  const config: FactoryConfig = {
    repo: { ...file.repo, path: resolve(root, file.repo.path) },
    intake_label: file.intake_label,
    branch_prefix: file.branch_prefix,
    dials: { spec_gate_min_tier: file.dials.spec_gate_min_tier as Tier, auto_merge_max_tier: 0 },
    floors: file.floors.map((f) => ({ prefix: f.prefix, tier: f.tier as Tier })),
    max_loops: file.max_loops,
    max_attempts: file.max_attempts,
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
    triage: await readFile(join(root, "prompts", "triage.md"), "utf8"),
    implement: await readFile(join(root, "prompts", "implement.md"), "utf8"),
    review: await readFile(join(root, "prompts", "review.md"), "utf8"),
  };
  return { root, file, config, prompts, secretsFile, stateDir, store, plugins, registry };
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
  });

  return { loaded, clock, store, secrets, controller, worker, close: () => store.close() };
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

function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}
