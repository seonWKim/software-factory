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
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { GitHubAuthProvider, NoAuthProvider } from "./impl/auth/github-auth-provider.js";
import { GitHubToolBroker } from "./impl/broker/github-tool-broker.js";
import { SystemClock } from "./impl/clock/system-clock.js";
import { PatternEgressScanner } from "./impl/egress/pattern-egress-scanner.js";
import { GitHubClient } from "./impl/github/github-client.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import { baseEnv } from "./impl/process/run-process.js";
import { ClaudeCodeRunner } from "./impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "./impl/sandbox/noop-sandbox.js";
import { EnvFileSecretStore, defaultSecretsFile } from "./impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "./impl/source/github-issue-source.js";
import { FsSharedStorage } from "./impl/storage/fs-shared-storage.js";
import { MysqlDriver } from "./impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "./impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "./impl/store/sqlite/sqlite-driver.js";

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
  auth: "github" | "none";
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
}

export async function loadConfig(root = process.cwd()): Promise<Loaded> {
  const file = JSON.parse(await readFile(join(root, "factory.config.json"), "utf8")) as FileConfig;
  if (file.env !== "local") throw new Error(`env "${file.env}" has no implementations yet; only "local"`);
  if (file.dials.auto_merge_max_tier !== 0) {
    throw new Error("auto_merge_max_tier must be 0: auto-merge is not implemented, and loosening is a human decision");
  }
  if (!isTier(file.dials.spec_gate_min_tier) || !file.floors.every((f) => isTier(f.tier))) {
    throw new Error("tiers must be integers 1–5");
  }
  if (file.heartbeat_ms * 2 >= file.lease_ms) throw new Error("heartbeat_ms must be well under lease_ms");
  const store = file.store ?? { type: "sqlite" };
  if (store.type === "mysql" && !(isSqlName(store.database) && isSqlName(store.user))) {
    throw new Error("store.database and store.user must match [A-Za-z0-9_]+");
  }

  const secretsFile = defaultSecretsFile();
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
  return { root, file, config, prompts, secretsFile, stateDir, store };
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

export async function build(
  loaded: Loaded,
  opts: { clock?: Clock; extraScanValues?: string[] } = {},
): Promise<Built> {
  const { config, file, stateDir } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const clock = opts.clock ?? new SystemClock();
  const secrets = new EnvFileSecretStore(loaded.secretsFile, opts.extraScanValues ?? []);
  const store = await openStore(loaded, secrets, clock);
  await store.migrate();

  const scanner = new PatternEgressScanner(() => secrets.valuesForScan());
  const github = new GitHubClient(secrets);
  const repo = { owner: config.repo.owner, name: config.repo.name };
  const sandbox = new NoOpSandbox(resolve(loaded.root, file.worktrees_dir));

  const controller = new Controller({
    store,
    source: new GitHubIssueSource(github, repo, config.intake_label, config.branch_prefix),
    auth: file.auth === "github" ? new GitHubAuthProvider(github, repo) : new NoAuthProvider(),
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
  });

  const worker = new Worker({
    id: `${hostname()}:${process.pid}` as WorkerId,
    store,
    sandbox,
    runner: new ClaudeCodeRunner({
      sandbox,
      secrets,
      claudeConfigDir: join(stateDir, "agents", "claude-config"),
      homesDir: join(stateDir, "agents", "homes"),
      models: file.models,
    }),
    broker: new GitHubToolBroker({ client: github, secrets, store, scanner, clock, repo, branchPrefix: config.branch_prefix }),
    scanner,
    storage: new FsSharedStorage(join(stateDir, "storage")),
    clock,
    config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(),
  });

  return { loaded, clock, store, secrets, controller, worker, close: () => store.close() };
}

export async function openStore(loaded: Loaded, secrets: SecretStore, clock: Clock): Promise<FactoryStore> {
  const s = loaded.store;
  if (s.type === "sqlite") return new SqlFactoryStore(new SqliteDriver(join(loaded.stateDir, "db", "factory.db")), clock);
  const password = await secrets.get("MYSQL_PASSWORD");
  if (!password) throw new Error("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
  const driver = new MysqlDriver({ host: s.host, port: s.port, database: s.database, user: s.user, password: password.reveal() });
  return new SqlFactoryStore(driver, clock);
}

export function isSqlName(s: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(s);
}

function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}
