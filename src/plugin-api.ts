// What a plugin descriptor file (`*.plugin.ts` beside its implementation under src/impl/) builds with
// definePlugin, and the registry types the loader in src/plugins.ts fills from those files (design D6).
//
// Kept apart from src/plugins.ts on purpose: src/plugins.ts imports every descriptor at startup (top-level
// await), so a descriptor that imported src/plugins.ts back would wait on itself. Descriptors import this
// module only.

import type { Loaded } from "./compose.js";
import { ConfigKeyError, suggestion } from "./config-keys.js";
import type { Logger } from "./core/log.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { AuthProvider, GrantSource } from "./interfaces/auth-provider.js";
import type { CalendarSource } from "./interfaces/calendar-source.js";
import type { Capability, CapabilitySearch } from "./interfaces/capability-search.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Forge } from "./interfaces/forge.js";
import type { KeepAwake } from "./interfaces/keep-awake.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { NetworkProbe } from "./interfaces/network-probe.js";
import type { ExecutionEngines } from "./worker/engine/index.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretName, SecretStore } from "./interfaces/secret-store.js";
// Re-exported so a component's plugin declares its secret names without importing a legacy folder (RFC 0015 §9).
export { secretName } from "./interfaces/secret-store.js";
import type { SharedStorage } from "./interfaces/shared-storage.js";
import type { SourceAdapter } from "./interfaces/source-adapter.js";
import type { TacitLedger } from "./interfaces/tacit-ledger.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { ChildLauncher, CommandRunner, Updater } from "./interfaces/updater.js";
import type { GitHubAccess, GitHubApi, GitHubCredentials } from "./interfaces/github-credentials.js";
import type { BusPlugin } from "./bus/index.js";
import type { TickSource } from "./shared/ticks/tick-generator.js";

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
  /** The credentials and the one forge client over them (docs/plugins/github-credentials.md). */
  github_auth: GitHubAccess;
  forge: Forge;
  network_probe: NetworkProbe;
  /** Builds each component's EventBus and the retry scheduler (docs/plugins/event-bus.md). */
  bus: BusPlugin;
  /** Makes each component's TickGenerator (docs/plugins/tick-generator.md). */
  ticks: TickSource;
  /** One ExecutionEngine per worker loop (docs/plugins/execution-engine.md). */
  engine: ExecutionEngines;
  /** The owner's tacit-knowledge ledger, where pushbacks are captured (docs/plugins/tacit-ledger.md). */
  tacit: TacitLedger;
  /** A calendar the factory reads (docs/plugins/calendar-source.md); selected as a list by the top-level `calendar` key. */
  calendar: CalendarSource;
}

export type PluginKind = keyof Instances;

/**
 * Kinds config may leave unselected (issue #172): no plugin is their default, and an absent value or "none"
 * selects nothing. Never a guard. `calendar` is selected as a list (`calendars` in the Selection), never one name.
 */
export type OptionalKind = "forge" | "calendar";

/** Everything a plugin may read: the loaded config, plus the extra values a canary run adds to the scan. */
export interface BaseContext {
  loaded: Loaded;
  repo: { owner: string; name: string };
  /** Values that are not secrets of ours but must never leave (the G6 canary). */
  extraScanValues: readonly string[];
}

/** The typed context each interface's factories get: only the dependencies that interface needs. */
export interface Contexts {
  store: BaseContext & { secrets: SecretStore; clock: Clock };
  sandbox: BaseContext;
  /**
   * `broker` and `scanner`: what a runner needs to expose granted broker tools to its agent (`tool_grants`). build()
   * passes both (the broker is built first); callers that grant nothing (canary, golden) may leave them out.
   */
  runner: BaseContext & { sandbox: Sandbox; secrets: SecretStore; broker?: ToolBroker; scanner?: EgressScanner };
  llm: BaseContext & { secrets: SecretStore };
  /** `grants`: the selected grant sources (`permissions.grants`), built before the auth plugin. */
  auth: BaseContext & { github: GitHubApi; store: FactoryStore; grants: readonly GrantSource[] };
  secrets: BaseContext;
  egress: BaseContext & { secrets: SecretStore };
  broker: BaseContext & { github: GitHubApi; credentials: GitHubCredentials; secrets: SecretStore; store: FactoryStore; scanner: EgressScanner; clock: Clock };
  storage: BaseContext;
  /**
   * `store`: what a source that keeps its intake in the store reads (the `local` source, issue #199). `secrets`,
   * `scanner` and `log`: what a source with its own credentials and its own posts needs (the `slack` source,
   * issue #109: its tokens from the SecretStore, G5 on every message before it is posted).
   */
  /** `clock`: build() always passes it; a polled source needs it (the GitHub source's starting point). */
  source: BaseContext & { github: GitHubApi; store: FactoryStore; secrets: SecretStore; scanner: EgressScanner; log: Logger; clock?: Clock };
  capability: BaseContext & { capabilities: readonly Capability[] };
  clock: BaseContext;
  /** The `dev` supervisor's: a command runner (runProcess) and a child launcher, both fakeable. */
  updater: BaseContext & { run: CommandRunner; launcher: ChildLauncher; clock: Clock; log: Logger };
  awake: BaseContext & { clock: Clock };
  github_auth: BaseContext & { secrets: SecretStore; clock: Clock };
  /** The pre-push checks' throwaway database (design §4); `none` is its one plugin. */
  /** `credentials`: what a run's push needs; only outbound's targets call the forge's writes (RFC 0015 M7, G2). */
  forge: BaseContext & { github: GitHubApi; credentials?: GitHubCredentials };
  /** The network pause's probe (design §5 Restarts): the selection and the config name its endpoints. */
  network_probe: BaseContext;
  /** The database comes later, per component, from the role that runs it. */
  bus: BaseContext;
  ticks: BaseContext;
  /** The journal keeps its steps in the store's database. */
  engine: BaseContext & { store: FactoryStore };
  /** Built for the controller only; the plugin finds its own home. */
  tacit: BaseContext;
  /** `secrets`: what a provider reads its credentials from. `clock`: "now", for the provider's own window. */
  calendar: BaseContext & { secrets: SecretStore; clock: Clock };
}

/** What a plugin's setup hook gets: the forge client (no credentials), and where to print its progress lines. */
export interface SetupContext extends BaseContext {
  github: GitHubApi;
  print: (line: string) => void;
}

export type SetupHook = (ctx: SetupContext) => Promise<void>;

/**
 * What a plugin's connect hook gets (`factory setup <kind> <command>`): plain values and functions only. `secrets`
 * reads the secret file as if the plugin were selected; it stays read-only, so the hook writes through
 * `storeSecrets` (every value at once, after all its checks) and `removeSecrets`. `ask.hidden` reads a value
 * without echoing it. Nothing a hook prints may carry a secret value.
 */
export interface ConnectContext {
  secretsFile: string;
  secrets: SecretStore;
  ask: { yesNo(question: string, dflt: boolean): Promise<boolean>; hidden(prompt: string): Promise<string> };
  print: (line: string) => void;
  openBrowser: (url: string) => Promise<void>;
  storeSecrets: (values: ReadonlyMap<SecretName, string>) => Promise<void>;
  removeSecrets: (names: readonly SecretName[]) => Promise<void>;
  clock: Clock;
}

/**
 * A plugin's account connection: `factory setup <kind> <command>` runs `connect`, and `--disconnect` runs
 * `disconnect`; the CLI then lists or unlists the plugin in its kind's config key. A failure throws; its message is
 * printed, so it never holds a secret value. Only the calendar kind, selected by a top-level list, takes one.
 */
export interface ConnectHook {
  /** The word after `factory setup <kind>`; unique within the kind. */
  command: string;
  connect(ctx: ConnectContext): Promise<void>;
  disconnect(ctx: ConnectContext): Promise<void>;
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
  /** One-time work `npm run setup` does for this plugin when it is selected (the github-issues labels); see selectedSetups. */
  setup?: SetupHook;
  /** How `factory setup <kind> <command>` connects this plugin's account; see connectHooks. */
  connect?: ConnectHook;
  /**
   * Absent: not a default. store and auth take none: their top-level config keys always pick one. Optional
   * kinds (forge) take none either: leaving their key out selects nothing.
   */
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
  /** Optional kinds (forge): no default, and an absent value or "none" selects nothing. Never a guard. */
  optional: boolean;
  plugins: Readonly<Record<string, PluginFactory<K>>>;
  /**
   * The secret names each plugin reads, one per plugin name (an empty list for none). The SecretStore
   * loads and scans exactly the union of the selected plugins' names (declaredSecretNames).
   */
  secrets: Readonly<Record<string, readonly SecretDeclaration[]>>;
  /** The setup hook of each plugin that has one. */
  setups: Readonly<Record<string, SetupHook>>;
  /** The connect hook of each plugin that has one. */
  connects: Readonly<Record<string, ConnectHook>>;
  /** From the descriptors' `default` fields. */
  defaults: KindDefaults;
}

export type Registry = { readonly [K in PluginKind]: InterfaceEntry<K> };

/**
 * One plugin name per interface, as selected by config. `plugins.source` may list several sources (design
 * 2026-11-01): then `sources` holds them all, in config order, and `source` is the first. `plugins.runner` and
 * `plugins.llm` may list a fallback chain (design 2026-11-07) the same way, in `runners` and `llms`. A single
 * name, or a list of one, leaves the list out, so the selection is exactly what one name always gave. An
 * optional kind (forge) is absent when config selects none.
 */
export type Selection = { [K in Exclude<PluginKind, OptionalKind>]: string } & { [K in OptionalKind]?: string } & {
  sources?: readonly string[];
  runners?: readonly string[];
  llms?: readonly string[];
  /** The auth plugin for local commands (CLI, local UI), when `auth` names one per origin (issue #318). */
  local_auth?: string;
  /** The auth plugin for Slack thread commands, when `auth.slack_thread` names one (issue #486). Absent: the `local` origin's (issue #498). */
  slack_auth?: string;
  /** The CalendarSource plugins the top-level `calendar` key lists, in config order; absent when it lists none. */
  calendars?: readonly string[];
};

/**
 * The origins `auth` can name a plugin for: GitHub comments, local commands (CLI, local UI; issue #318) and Slack
 * thread commands (issue #486).
 */
const AUTH_ORIGINS = ["github_issue", "local", "slack_thread"] as const;

/**
 * `auth` per command origin (issue #318). A string (the form before) selects the plugin for GitHub comments;
 * local commands then use `local`. An object maps origins to plugins: `github_issue` is required, `local`
 * optional (default `local`), `slack_thread` optional (default: the `local` origin's plugin, issues #486 and #498).
 */
export function authByOrigin(raw: unknown): { github_issue: unknown; local?: unknown; slack_thread?: unknown } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { github_issue: raw };
  const given = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(given)) {
    if (!(AUTH_ORIGINS as readonly string[]).includes(key)) {
      problems.push(`unknown auth origin "${key}"; known origins: ${AUTH_ORIGINS.join(", ")}${suggestion(key, [...AUTH_ORIGINS])}`);
    }
  }
  if (!Object.hasOwn(given, "github_issue")) problems.push('auth needs "github_issue": the auth plugin for GitHub comments');
  if (problems.length > 0) throw new ConfigKeyError(problems);
  return {
    github_issue: given.github_issue,
    ...(Object.hasOwn(given, "local") ? { local: given.local } : {}),
    ...(Object.hasOwn(given, "slack_thread") ? { slack_thread: given.slack_thread } : {}),
  };
}

/**
 * The auth plugin that authorizes commands from the local CLI and the local UI (issue #318): `auth.local` in the
 * per-origin form, else `local`, whatever `auth` selects for GitHub comments. Local commands never depend on it.
 */
export function selectedLocalAuth(selection: Selection): string {
  return selection.local_auth ?? "local";
}

/** Every selected SourceAdapter plugin name, in config order: `sources`, or `[source]` when one is selected. */
export function selectedSources(selection: Selection): readonly string[] {
  return selection.sources ?? [selection.source];
}

/** Every selected CalendarSource plugin name, in config order: none unless the top-level `calendar` key lists some. */
export function selectedCalendars(selection: Selection): readonly string[] {
  return selection.calendars ?? [];
}

/** The AgentRunner fallback chain, in config order: `runners`, or `[runner]` when one is selected. */
export function selectedRunners(selection: Selection): readonly string[] {
  return selection.runners ?? [selection.runner];
}

/** The LLMProvider fallback chain, in config order: `llms`, or `[llm]` when one is selected. */
export function selectedLlms(selection: Selection): readonly string[] {
  return selection.llms ?? [selection.llm];
}

function selectedNames(selection: Selection, kind: PluginKind): readonly string[] {
  if (kind === "source") return selectedSources(selection);
  if (kind === "runner") return selectedRunners(selection);
  if (kind === "llm") return selectedLlms(selection);
  if (kind === "calendar") return selectedCalendars(selection);
  const name = selection[kind];
  return name === undefined ? [] : [name];
}

/**
 * Every secret the selected plugins declare, one entry per name (in interface order; purposes of a
 * name declared by several plugins are joined with "; "). What setup and doctor list.
 */
export function declaredSecrets(registry: Registry, selection: Selection): SecretDeclaration[] {
  const byName = new Map<SecretName, SecretDeclaration>();
  for (const kind of Object.keys(registry) as PluginKind[]) {
    const names = selectedNames(selection, kind);
    for (const d of names.flatMap((n) => registry[kind].secrets[n] ?? [])) {
      const seen = byName.get(d.name);
      if (!seen) byName.set(d.name, { ...d });
      else if (!seen.purpose.includes(d.purpose)) seen.purpose = `${seen.purpose}; ${d.purpose}`;
    }
  }
  return [...byName.values()];
}

/** The setup hooks of the selected plugins, in interface order, each with the plugin it belongs to. What `npm run setup` runs. */
export function selectedSetups(registry: Registry, selection: Selection): { kind: PluginKind; name: string; setup: SetupHook }[] {
  return (Object.keys(registry) as PluginKind[]).flatMap((kind) =>
    selectedNames(selection, kind).flatMap((name) => {
      const setup = registry[kind].setups[name];
      return setup ? [{ kind, name, setup }] : [];
    }),
  );
}

/** Every plugin's connect hook, selected or not, in interface order: what `factory setup <kind> <command>` runs. */
export function connectHooks(registry: Registry): { kind: PluginKind; name: string; hook: ConnectHook }[] {
  return (Object.keys(registry) as PluginKind[]).flatMap((kind) =>
    Object.entries(registry[kind].connects).map(([name, hook]) => ({ kind, name, hook })),
  );
}

/** The secret set: the union of the names the selected plugins declare. The SecretStore loads and scans these. */
export function declaredSecretNames(registry: Registry, selection: Selection): ReadonlySet<SecretName> {
  return new Set(declaredSecrets(registry, selection).map((d) => d.name));
}

/**
 * Grant plugins (kind `grant`, design 2026-11-01): sources of roles for the one authorize check
 * (src/core/authorize.ts). Several are selected at once, by the list `permissions.grants`, and their union
 * decides, minus denies. Each is a `*.grant.ts` descriptor beside its implementation under src/impl/, kept out
 * of the one-per-interface Registry above because a kind selected as a list has no single selection.
 */
export interface GrantContext extends BaseContext {
  github: GitHubApi;
}

export interface GrantDescriptor {
  /** The name `permissions.grants` lists; unique among grants. */
  name: string;
  create: (ctx: GrantContext) => GrantSource | Promise<GrantSource>;
  /** Selected when `permissions.grants` is absent. */
  default?: true;
}

/** Typed identity for a `*.grant.ts` file: `export default defineGrant({...})`. */
export function defineGrant(descriptor: GrantDescriptor): GrantDescriptor {
  return descriptor;
}
