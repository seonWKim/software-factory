// Plugin registry (design D11): every implementation of an infra interface is a named plugin, chosen by
// name in factory.config.json. This file is the only non-test code that constructs those implementations;
// src/compose.ts, src/canary.ts and src/setup.ts resolve them through it. docs/plugins.md describes each
// one and `tests/plugins.test.ts` keeps the two in step.
//
// Guards (SecretStore, EgressScanner, ToolBroker; docs/architecture.md §5, G1–G6) can be switched to
// another plugin, but never disabled: config that selects nothing for a guard fails at startup.

import { join, resolve } from "node:path";
import type { Loaded } from "./compose.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { AuthProvider } from "./interfaces/auth-provider.js";
import type { Capability, CapabilitySearch } from "./interfaces/capability-search.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import type { SharedStorage } from "./interfaces/shared-storage.js";
import type { SourceAdapter } from "./interfaces/source-adapter.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import { GitHubAuthProvider, NoAuthProvider } from "./impl/auth/github-auth-provider.js";
import { GitHubToolBroker } from "./impl/broker/github-tool-broker.js";
import { ListAllCapabilitySearch } from "./impl/capability/list-all-capability-search.js";
import { SystemClock } from "./impl/clock/system-clock.js";
import { PatternEgressScanner } from "./impl/egress/pattern-egress-scanner.js";
import type { GitHubClient, RepoRef } from "./impl/github/github-client.js";
import { ClaudeCliLLMProvider } from "./impl/llm/claude-cli-llm-provider.js";
import { ClaudeCodeRunner } from "./impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "./impl/sandbox/noop-sandbox.js";
import { EnvFileSecretStore } from "./impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "./impl/source/github-issue-source.js";
import { FsSharedStorage } from "./impl/storage/fs-shared-storage.js";
import { MysqlDriver } from "./impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "./impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "./impl/store/sqlite/sqlite-driver.js";

/** What each interface's plugins produce. The key is the interface's short name, used in config and errors. */
export interface Instances {
  store: FactoryStore;
  sandbox: Sandbox;
  runner: AgentRunner;
  llm: LLMProvider;
  auth: AuthProvider;
  secrets: SecretStore;
  egress: EgressScanner;
  broker: ToolBroker;
  storage: SharedStorage;
  source: SourceAdapter;
  capability: CapabilitySearch;
  clock: Clock;
}

export type PluginKind = keyof Instances;

/** Everything a plugin may read: the loaded config, plus the extra values a canary run adds to the scan. */
export interface BaseContext {
  loaded: Loaded;
  repo: RepoRef;
  /** Values that are not secrets of ours but must never leave (the G6 canary). */
  extraScanValues: readonly string[];
}

/** The typed context each interface's factories get: only the dependencies that interface needs. */
export interface Contexts {
  store: BaseContext & { secrets: SecretStore; clock: Clock };
  sandbox: BaseContext;
  runner: BaseContext & { sandbox: Sandbox; secrets: SecretStore };
  llm: BaseContext & { secrets: SecretStore };
  auth: BaseContext & { github: GitHubClient };
  secrets: BaseContext;
  egress: BaseContext & { secrets: SecretStore };
  broker: BaseContext & { github: GitHubClient; secrets: SecretStore; store: FactoryStore; scanner: EgressScanner; clock: Clock };
  storage: BaseContext;
  source: BaseContext & { github: GitHubClient };
  capability: BaseContext & { capabilities: readonly Capability[] };
  clock: BaseContext;
}

export type PluginFactory<K extends PluginKind> = (ctx: Contexts[K]) => Instances[K] | Promise<Instances[K]>;

export interface InterfaceEntry<K extends PluginKind> {
  /** The interface's TypeScript name; also its heading in docs/plugins.md. */
  interface: string;
  /** Where config selects it, for error messages. */
  configKey: string;
  /** Guards can be switched but never disabled (architecture §5). */
  guard: boolean;
  plugins: Readonly<Record<string, PluginFactory<K>>>;
}

export type Registry = { readonly [K in PluginKind]: InterfaceEntry<K> };

/** One plugin name per interface, as selected by config. */
export type Selection = { [K in PluginKind]: string };

const dirs = (c: BaseContext) => ({
  claudeConfigDir: join(c.loaded.stateDir, "agents", "claude-config"),
  homesDir: join(c.loaded.stateDir, "agents", "homes"),
});

export const REGISTRY: Registry = {
  store: {
    interface: "FactoryStore",
    configKey: "store.type",
    guard: false,
    plugins: {
      sqlite: (c) => new SqlFactoryStore(new SqliteDriver(join(c.loaded.stateDir, "db", "factory.db")), c.clock),
      mysql: async (c) => {
        const s = c.loaded.store;
        if (s.type !== "mysql") throw new Error('store plugin "mysql" needs a store block with type "mysql"');
        const password = await c.secrets.get("MYSQL_PASSWORD");
        if (!password) throw new Error("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
        const driver = new MysqlDriver({ host: s.host, port: s.port, database: s.database, user: s.user, password: password.reveal() });
        return new SqlFactoryStore(driver, c.clock);
      },
    },
  },
  sandbox: {
    interface: "Sandbox",
    configKey: "plugins.sandbox",
    guard: false,
    plugins: { noop: (c) => new NoOpSandbox(resolve(c.loaded.root, c.loaded.file.worktrees_dir)) },
  },
  runner: {
    interface: "AgentRunner",
    configKey: "plugins.runner",
    guard: false,
    plugins: {
      "claude-code": (c) => new ClaudeCodeRunner({ sandbox: c.sandbox, secrets: c.secrets, ...dirs(c), models: c.loaded.file.models }),
    },
  },
  llm: {
    interface: "LLMProvider",
    configKey: "plugins.llm",
    guard: false,
    plugins: {
      "claude-cli": (c) =>
        new ClaudeCliLLMProvider({
          secrets: c.secrets,
          claudeConfigDir: dirs(c).claudeConfigDir,
          workDir: join(c.loaded.stateDir, "agents", "llm"),
          models: c.loaded.file.models,
        }),
    },
  },
  auth: {
    interface: "AuthProvider",
    configKey: "auth",
    guard: false,
    plugins: {
      github: (c) => new GitHubAuthProvider(c.github, c.repo),
      none: () => new NoAuthProvider(),
    },
  },
  secrets: {
    interface: "SecretStore",
    configKey: "plugins.secrets",
    guard: true,
    plugins: { "env-file": (c) => new EnvFileSecretStore(c.loaded.secretsFile, c.extraScanValues) },
  },
  egress: {
    interface: "EgressScanner",
    configKey: "plugins.egress",
    guard: true,
    plugins: { pattern: (c) => new PatternEgressScanner(() => c.secrets.valuesForScan()) },
  },
  broker: {
    interface: "ToolBroker",
    configKey: "plugins.broker",
    guard: true,
    plugins: {
      github: (c) =>
        new GitHubToolBroker({
          client: c.github,
          secrets: c.secrets,
          store: c.store,
          scanner: c.scanner,
          clock: c.clock,
          repo: c.repo,
          branchPrefix: c.loaded.config.branch_prefix,
        }),
    },
  },
  storage: {
    interface: "SharedStorage",
    configKey: "plugins.storage",
    guard: false,
    plugins: { fs: (c) => new FsSharedStorage(join(c.loaded.stateDir, "storage")) },
  },
  source: {
    interface: "SourceAdapter",
    configKey: "plugins.source",
    guard: false,
    plugins: {
      "github-issues": (c) => new GitHubIssueSource(c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix),
    },
  },
  capability: {
    interface: "CapabilitySearch",
    configKey: "plugins.capability",
    guard: false,
    plugins: { "list-all": (c) => new ListAllCapabilitySearch(c.capabilities) },
  },
  clock: {
    interface: "Clock",
    configKey: "plugins.clock",
    guard: false,
    plugins: { system: () => new SystemClock() },
  },
};

export const PLUGIN_KINDS = Object.keys(REGISTRY) as PluginKind[];

/** The interfaces selected under the `plugins` config object. Store and auth keep their own keys. */
export const PLUGINS_KEYS = PLUGIN_KINDS.filter((k) => k !== "store" && k !== "auth");

/** Today's behaviour, used when factory.config.json has no `plugins` object. */
export const DEFAULT_PLUGINS: Readonly<Record<(typeof PLUGINS_KEYS)[number], string>> = {
  sandbox: "noop",
  runner: "claude-code",
  llm: "claude-cli",
  secrets: "env-file",
  egress: "pattern",
  broker: "github",
  storage: "fs",
  source: "github-issues",
  capability: "list-all",
  clock: "system",
};

/** Values that mean "turn this off". Never accepted for a guard. */
const DISABLING = new Set<unknown>([undefined, null, false, "", "none"]);

/**
 * Throws unless `value` names a plugin registered for `kind`. For guards, any disabling value (missing,
 * null, false, "", "none", or anything that is not a registered name) fails with the guard message.
 */
export function checkPlugin(registry: Registry, kind: PluginKind, value: unknown): string {
  const entry = registry[kind];
  const names = Object.keys(entry.plugins);
  const available = `available: ${names.join(", ")}`;
  if (typeof value === "string" && Object.hasOwn(entry.plugins, value)) return value;
  if (entry.guard && (DISABLING.has(value) || typeof value !== "string")) {
    throw new Error(
      `${entry.configKey} selects no ${entry.interface} (got ${JSON.stringify(value) ?? "nothing"}): ` +
        `${entry.interface} is a guard and cannot be disabled (docs/architecture.md §5, G1–G6). ` +
        `Select another ${entry.interface} plugin instead; ${available}`,
    );
  }
  throw new Error(`unknown ${entry.interface} plugin ${JSON.stringify(value) ?? "(missing)"} at ${entry.configKey}; ${available}`);
}

/**
 * Turns the raw config into one checked plugin name per interface. No `plugins` object means today's
 * defaults. A `plugins` object must name every guard explicitly; other interfaces fall back to defaults.
 */
export function selectPlugins(
  registry: Registry,
  raw: { store: { type: unknown }; auth: unknown; plugins?: unknown },
): Selection {
  let chosen: Record<string, unknown>;
  if (raw.plugins === undefined) chosen = { ...DEFAULT_PLUGINS };
  else {
    if (raw.plugins === null || typeof raw.plugins !== "object" || Array.isArray(raw.plugins)) {
      throw new Error("plugins must be an object mapping interface to plugin name (see docs/plugins.md)");
    }
    const given = raw.plugins as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!(PLUGINS_KEYS as string[]).includes(key)) {
        const hint = key === "store" || key === "auth" ? `; ${key} is selected by the top-level "${key}" key` : "";
        throw new Error(`unknown plugins key "${key}"${hint}; known keys: ${PLUGINS_KEYS.join(", ")}`);
      }
    }
    chosen = {};
    for (const key of PLUGINS_KEYS) {
      chosen[key] = Object.hasOwn(given, key) ? given[key] : registry[key].guard ? undefined : DEFAULT_PLUGINS[key];
    }
  }
  chosen.store = raw.store.type;
  chosen.auth = raw.auth;
  const out = {} as Selection;
  for (const kind of PLUGIN_KINDS) out[kind] = checkPlugin(registry, kind, chosen[kind]);
  return out;
}

/** Builds the selected plugin for `kind`. Checks the name again, so build() cannot run a bad selection. */
export async function createPlugin<K extends PluginKind>(
  registry: Registry,
  kind: K,
  name: string,
  ctx: Contexts[K],
): Promise<Instances[K]> {
  const entry = registry[kind] as InterfaceEntry<K>;
  const factory = entry.plugins[checkPlugin(registry, kind, name)]!;
  return factory(ctx);
}

/** A copy of `registry` with one more plugin. For tests and in-repo additions; there is no external loading. */
export function withPlugin<K extends PluginKind>(
  registry: Registry,
  kind: K,
  name: string,
  factory: PluginFactory<K>,
): Registry {
  const entry = registry[kind] as InterfaceEntry<K>;
  if (entry.guard && DISABLING.has(name)) throw new Error(`"${name}" cannot name a ${entry.interface} plugin: it means disabled`);
  return { ...registry, [kind]: { ...entry, plugins: { ...entry.plugins, [name]: factory } } };
}
