// What a plugin descriptor file (`*.plugin.ts` beside its implementation under src/impl/) builds with
// definePlugin, and the registry types the loader in src/plugins.ts fills from those files (design D6).
//
// Kept apart from src/plugins.ts on purpose: src/plugins.ts imports every descriptor at startup (top-level
// await), so a descriptor that imported src/plugins.ts back would wait on itself. Descriptors import this
// module only.

import type { Loaded } from "./compose.js";
import type { Logger } from "./core/log.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { AuthProvider } from "./interfaces/auth-provider.js";
import type { Capability, CapabilitySearch } from "./interfaces/capability-search.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { KeepAwake } from "./interfaces/keep-awake.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretName, SecretStore } from "./interfaces/secret-store.js";
import type { SharedStorage } from "./interfaces/shared-storage.js";
import type { SourceAdapter } from "./interfaces/source-adapter.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { ChildLauncher, CommandRunner, Updater } from "./interfaces/updater.js";
import type { GitHubCredentials } from "./interfaces/github-credentials.js";
import type { GitHubClient, RepoRef } from "./impl/github/github-client.js";

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
  updater: Updater;
  awake: KeepAwake;
  github_auth: GitHubCredentials;
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
  broker: BaseContext & { github: GitHubClient; credentials: GitHubCredentials; secrets: SecretStore; store: FactoryStore; scanner: EgressScanner; clock: Clock };
  storage: BaseContext;
  source: BaseContext & { github: GitHubClient };
  capability: BaseContext & { capabilities: readonly Capability[] };
  clock: BaseContext;
  /** The `dev` supervisor's: a command runner (runProcess) and a child launcher, both fakeable. */
  updater: BaseContext & { run: CommandRunner; launcher: ChildLauncher; clock: Clock; log: Logger };
  awake: BaseContext & { clock: Clock };
  github_auth: BaseContext & { secrets: SecretStore; clock: Clock };
}

export type PluginFactory<K extends PluginKind> = (ctx: Contexts[K]) => Instances[K] | Promise<Instances[K]>;

/** One secret a plugin reads from the SecretStore, with one line on what it is for. */
export interface SecretDeclaration {
  name: SecretName;
  purpose: string;
  /**
   * Declarations with the same `oneOf` label are alternatives: one present value is enough (for
   * example the model credential, an OAuth token or an API key). Absent: the secret is required.
   */
  oneOf?: string;
}

/**
 * When a plugin is its interface's default (used for a `plugins` key config leaves out).
 * `true`: on every platform no other plugin of the kind claims by name. `{ platforms }`: on those
 * `process.platform` values only (awake: `caffeinate` on `darwin`, `none` with `true` elsewhere).
 */
export type PluginDefault = true | { readonly platforms: readonly string[] };

/** One plugin, described in its own `*.plugin.ts` file as `export default definePlugin({...})`. */
export interface PluginDescriptor<K extends PluginKind = PluginKind> {
  kind: K;
  /** The name config selects; unique within the kind. */
  name: string;
  create: PluginFactory<K>;
  /** The secret names this plugin reads (none if left out); see declaredSecrets. */
  secrets?: readonly SecretDeclaration[];
  /** Absent: not a default. store and auth take none: their top-level config keys always pick one. */
  default?: PluginDefault;
}

/** Typed identity: checks the factory against its kind's context and instance types. */
export function definePlugin<K extends PluginKind>(descriptor: PluginDescriptor<K>): PluginDescriptor<K> {
  return descriptor;
}

/** The default plugin names of one kind: per platform, else the fallback. */
export interface KindDefaults {
  fallback?: string;
  platforms: Readonly<Record<string, string>>;
}

export interface InterfaceEntry<K extends PluginKind> {
  /** The interface's TypeScript name; also its heading in docs/plugins.md. */
  interface: string;
  /** Where config selects it, for error messages. */
  configKey: string;
  /** Guards can be switched but never disabled (architecture §5). */
  guard: boolean;
  plugins: Readonly<Record<string, PluginFactory<K>>>;
  /**
   * The secret names each plugin reads, one per plugin name (an empty list for none). The SecretStore
   * loads and scans exactly the union of the selected plugins' names (declaredSecretNames).
   */
  secrets: Readonly<Record<string, readonly SecretDeclaration[]>>;
  /** From the descriptors' `default` fields. */
  defaults: KindDefaults;
}

export type Registry = { readonly [K in PluginKind]: InterfaceEntry<K> };

/**
 * One plugin name per interface, as selected by config. `plugins.source` may list several sources (design
 * 2026-11-01): then `sources` holds them all, in config order, and `source` is the first. A single name, or a
 * list of one, leaves `sources` out, so the selection is exactly what one name always gave.
 */
export type Selection = { [K in PluginKind]: string } & { sources?: readonly string[] };

/** Every selected SourceAdapter plugin name, in config order: `sources`, or `[source]` when one is selected. */
export function selectedSources(selection: Selection): readonly string[] {
  return selection.sources ?? [selection.source];
}

/**
 * Every secret the selected plugins declare, one entry per name (in interface order; purposes of a
 * name declared by several plugins are joined with "; "). What setup and doctor list.
 */
export function declaredSecrets(registry: Registry, selection: Selection): SecretDeclaration[] {
  const byName = new Map<SecretName, SecretDeclaration>();
  for (const kind of Object.keys(registry) as PluginKind[]) {
    const names = kind === "source" ? selectedSources(selection) : [selection[kind]];
    for (const d of names.flatMap((n) => registry[kind].secrets[n] ?? [])) {
      const seen = byName.get(d.name);
      if (!seen) byName.set(d.name, { ...d });
      else if (!seen.purpose.includes(d.purpose)) seen.purpose = `${seen.purpose}; ${d.purpose}`;
    }
  }
  return [...byName.values()];
}

/** The secret set: the union of the names the selected plugins declare. The SecretStore loads and scans these. */
export function declaredSecretNames(registry: Registry, selection: Selection): ReadonlySet<SecretName> {
  return new Set(declaredSecrets(registry, selection).map((d) => d.name));
}
