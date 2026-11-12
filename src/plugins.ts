// Plugin registry (design D6): every implementation of an infra interface is a named plugin, chosen by
// name in factory.config.json. Each plugin describes itself in a `*.plugin.ts` file beside its
// implementation, anywhere under src/ (legacy src/impl/ or a component's plugins/ folder; `export default
// definePlugin({...})`, src/plugin-api.ts). At startup the
// loader below finds those files (`*.plugin.js` once built), sorts them by path, imports each and fills
// REGISTRY. Each config load adds the packs' plugins to a copy of it (withPackPlugins, design 11-packs.md).
// This file names no plugin and imports no implementation: only a new interface edits it.
// src/compose.ts, src/canary.ts and src/setup.ts resolve plugins through it; docs/plugins.md describes
// each one and `tests/plugins.test.ts` keeps the two in step.
//
// Guards (SecretStore, EgressScanner, ToolBroker; docs/architecture.md §5, G1–G6) can be switched to
// another plugin, but never disabled: config that selects nothing for a guard fails at startup.
//
// Optional kinds (Forge, issue #172) have no default plugin: "none" selects nothing. Leaving `plugins.forge` out
// lets src/compose.ts derive it from the sources (withForgeDefault, issue #273). CalendarSource is optional too, and
// selected as a list by its own top-level `calendar` key (default [], design 02-tasks).

import { pathToFileURL } from "node:url";
import { ConfigKeyError, suggestion } from "./config-keys.js";
import { findDescriptorFiles } from "./state/index.js";
import type {
  Contexts,
  Instances,
  InterfaceEntry,
  KindDefaults,
  PluginDescriptor,
  PluginFactory,
  PluginKind,
  Registry,
  SecretDeclaration,
  Selection,
  SetupHook,
  ConnectHook,
} from "./plugin-api.js";

export type {
  BaseContext,
  Contexts,
  InterfaceEntry,
  Instances,
  KindDefaults,
  PluginDefault,
  PluginDescriptor,
  PluginFactory,
  PluginKind,
  Registry,
  SecretDeclaration,
  Selection,
  SetupContext,
  SetupHook,
} from "./plugin-api.js";
export { connectHooks, declaredSecretNames, declaredSecrets, selectedSetups, definePlugin, selectedCalendars, selectedLlms, selectedRunners, selectedSources } from "./plugin-api.js";
import { selectedCalendars } from "./plugin-api.js";

interface KindInfo {
  /** The interface's TypeScript name; also its heading in docs/plugins.md. */
  interface: string;
  /** Where config selects it, for error messages. */
  configKey: string;
  /** Guards can be switched but never disabled (architecture §5). */
  guard: boolean;
  /** Optional kinds take no default; an absent value or "none" selects nothing. Never a guard. */
  optional: boolean;
  /**
   * An integration (design 08-settings, 2026-11-12): the runtime `integrations` setting may switch it without a restart,
   * over its config key. Never a guard; every other interface changes only by a reviewed PR to factory.config.json.
   */
  integration?: true;
}

/** The interfaces, in order. A new interface is the only reason to edit this file. */
const KINDS: { readonly [K in PluginKind]: KindInfo } = {
  store: { interface: "FactoryStore", configKey: "store.type", guard: false, optional: false },
  sandbox: { interface: "Sandbox", configKey: "plugins.sandbox", guard: false, optional: false },
  runner: { interface: "AgentRunner", configKey: "plugins.runner", guard: false, optional: false },
  llm: { interface: "LLMProvider", configKey: "plugins.llm", guard: false, optional: false },
  secrets: { interface: "SecretStore", configKey: "plugins.secrets", guard: true, optional: false },
  egress: { interface: "EgressScanner", configKey: "plugins.egress", guard: true, optional: false },
  broker: { interface: "ToolBroker", configKey: "plugins.broker", guard: true, optional: false },
  storage: { interface: "SharedStorage", configKey: "plugins.storage", guard: false, optional: false },
  source: { interface: "SourceAdapter", configKey: "plugins.source", guard: false, optional: false },
  capability: { interface: "CapabilitySearch", configKey: "plugins.capability", guard: false, optional: false },
  clock: { interface: "Clock", configKey: "plugins.clock", guard: false, optional: false },
  updater: { interface: "Updater", configKey: "plugins.updater", guard: false, optional: false },
  awake: { interface: "KeepAwake", configKey: "plugins.awake", guard: false, optional: false },
  github_auth: { interface: "GitHubCredentials", configKey: "plugins.github_auth", guard: false, optional: false },
  test_database: { interface: "TestDatabase", configKey: "plugins.test_database", guard: false, optional: false },
  forge: { interface: "Forge", configKey: "plugins.forge", guard: false, optional: true },
  network_probe: { interface: "NetworkProbe", configKey: "plugins.network_probe", guard: false, optional: false },
  bus: { interface: "EventBus", configKey: "plugins.bus", guard: false, optional: false },
  ticks: { interface: "TickGenerator", configKey: "plugins.ticks", guard: false, optional: false },
  engine: { interface: "ExecutionEngine", configKey: "plugins.engine", guard: false, optional: false },
  tacit: { interface: "TacitLedger", configKey: "plugins.tacit", guard: false, optional: false, integration: true },
  calendar: { interface: "CalendarSource", configKey: "calendar", guard: false, optional: true },
};

export const PLUGIN_KINDS = Object.keys(KINDS) as PluginKind[];

/** The interfaces marked `integration`: the only ones the runtime `integrations` setting switches. Never a guard. */
export const INTEGRATION_KINDS: readonly PluginKind[] = PLUGIN_KINDS.filter((k) => KINDS[k].integration === true);
for (const k of INTEGRATION_KINDS) if (KINDS[k].guard) throw new Error(`plugin registry: ${KINDS[k].interface} is a guard and cannot be an integration`);

/**
 * The runtime `integrations` setting checked against `registry` (design 08-settings): an object from an integration
 * interface to one of its registered plugin names. A guard, any other interface or an unknown name throws, naming it.
 */
export function checkIntegrations(registry: Registry, value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("integrations must be an object from interface to plugin name");
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(value)) {
    const known = Object.hasOwn(KINDS, key);
    const info = known ? KINDS[key as PluginKind] : null;
    if (info?.guard) throw new Error(`integrations: ${info.interface} (${key}) is a guard; it changes only by a reviewed PR to factory.config.json`);
    if (info?.integration !== true) {
      const which = info ? `${info.interface} (${key}) is not an integration; it changes only by a reviewed PR to factory.config.json` : `unknown interface "${key}"`;
      throw new Error(`integrations: ${which}; the integrations are ${INTEGRATION_KINDS.join(", ")}`);
    }
    const names = Object.keys(registry[key as PluginKind].plugins);
    if (typeof name !== "string" || !names.includes(name)) {
      const hint = typeof name === "string" ? suggestion(name, names) : "";
      throw new Error(`integrations: unknown ${info.interface} plugin ${JSON.stringify(name)} for ${key}; available: ${names.join(", ")}${hint}`);
    }
    out[key] = name;
  }
  return out;
}

/** Store and calendar are selected by their own top-level config keys, so they take no default. */
const TOP_LEVEL_KINDS: readonly PluginKind[] = ["store", "calendar"];

/** The interfaces selected under the `plugins` config object. Store and calendar keep their own keys. */
export const PLUGINS_KEYS = PLUGIN_KINDS.filter((k) => !TOP_LEVEL_KINDS.includes(k));

/** Values that mean "turn this off". Never accepted for a guard. */
const DISABLING = new Set<unknown>([undefined, null, false, "", "none"]);

/**
 * Where the built-in descriptors live: the whole code root (src/ in the source tree, dist/ once built), so a
 * component's plugins/ folder is found as well as legacy src/impl (RFC 0015 §6.1).
 */
export const PLUGIN_ROOT = import.meta.dirname;

/** `*.plugin.ts` (source) or `*.plugin.js` (built); never a `*.d.ts`. */
const DESCRIPTOR_FILE = /\.plugin\.(?:ts|js)$/;

/** Every descriptor file under `dirs`, recursively, sorted by path so registration order is stable. */
export function findPluginFiles(dirs: readonly string[], pattern: RegExp = DESCRIPTOR_FILE): string[] {
  return dirs.flatMap((dir) => findDescriptorFiles(dir, pattern)).sort();
}

interface Found {
  file: string;
  descriptor: PluginDescriptor;
}

/** Imports every descriptor file under `dirs` and builds a checked registry. Any problem fails startup. */
export async function loadRegistry(dirs: readonly string[]): Promise<Registry> {
  const found: Found[] = [];
  for (const file of findPluginFiles(dirs)) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    found.push({ file, descriptor: checkDescriptor(file, mod.default) });
  }
  return registryOf(found);
}

function checkDescriptor(file: string, d: unknown): PluginDescriptor {
  const bad = (why: string) => new Error(`plugin descriptor ${file}: ${why} (docs/plugins.md, "Adding a plugin")`);
  if (d === null || typeof d !== "object") throw bad("no default export; write `export default definePlugin({...})`");
  const { kind, name, create, secrets, setup, connect, default: dflt } = d as Record<string, unknown>;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) {
    throw bad(`unknown kind ${JSON.stringify(kind)}; known kinds: ${PLUGIN_KINDS.join(", ")}`);
  }
  const info = KINDS[kind as PluginKind];
  if (typeof name !== "string" || name === "") throw bad("name must be a non-empty string");
  if (info.guard && DISABLING.has(name)) throw bad(`"${name}" cannot name a ${info.interface} plugin: it means disabled`);
  if (typeof create !== "function") throw bad("create must be a function");
  if (secrets !== undefined && !Array.isArray(secrets)) throw bad("secrets must be a list");
  if (setup !== undefined && typeof setup !== "function") throw bad("setup must be a function");
  if (connect !== undefined) {
    const c = connect as Partial<Record<keyof ConnectHook, unknown>> | null;
    if (typeof c?.command !== "string" || !/^[a-z][a-z0-9-]*$/.test(c.command) || typeof c.connect !== "function" || typeof c.disconnect !== "function") {
      throw bad("connect must be { command: a lower-case word, connect(ctx), disconnect(ctx) }");
    }
    // The CLI lists or unlists a connected plugin in its kind's top-level list key; only calendar has one.
    if (kind !== "calendar") throw bad(`${kind} plugins take no connect hook: only calendar plugins, listed in the top-level "calendar" key, do`);
  }
  if (dflt !== undefined) {
    if (TOP_LEVEL_KINDS.includes(kind as PluginKind)) {
      throw bad(`${kind} plugins take no default: the top-level "${info.configKey}" config key always picks one`);
    }
    if (info.optional) throw bad(`${kind} plugins take no default: ${info.interface} is optional, selected only by "${info.configKey}"`);
    const platforms = (dflt as { platforms?: unknown } | null)?.platforms;
    const ok = dflt === true || (Array.isArray(platforms) && platforms.length > 0 && platforms.every((p) => typeof p === "string"));
    if (!ok) throw bad('default must be true or { platforms: ["darwin", ...] }');
  }
  return d as PluginDescriptor;
}

function registryOf(found: readonly Found[]): Registry {
  const errors: string[] = [];
  const registry = {} as Record<PluginKind, InterfaceEntry<PluginKind>>;
  for (const kind of PLUGIN_KINDS) {
    const info = KINDS[kind];
    const mine = found.filter((f) => f.descriptor.kind === kind);
    const label = `${info.interface} (${kind})`;
    const plugins: Record<string, PluginFactory<PluginKind>> = {};
    const secrets: Record<string, readonly SecretDeclaration[]> = {};
    const setups: Record<string, SetupHook> = {};
    const connects: Record<string, ConnectHook> = {};
    const fileOf = new Map<string, string>();
    for (const { file, descriptor: d } of mine) {
      const first = fileOf.get(d.name);
      if (first !== undefined) {
        errors.push(`${label} has two plugins named "${d.name}": ${first} and ${file}`);
        continue;
      }
      fileOf.set(d.name, file);
      plugins[d.name] = d.create as PluginFactory<PluginKind>;
      secrets[d.name] = d.secrets ?? [];
      if (d.setup) setups[d.name] = d.setup;
      if (d.connect) {
        const twin = Object.entries(connects).find(([, c]) => c.command === d.connect!.command);
        if (twin) errors.push(`${label} has two connect hooks for "setup ${kind} ${d.connect.command}": ${twin[0]} and ${d.name}`);
        else connects[d.name] = d.connect;
      }
    }
    if (info.guard && mine.length === 0) {
      errors.push(`${label} is a guard and has no plugin; guards cannot be disabled (docs/architecture.md §5)`);
    }
    const defaults: { fallback?: string; platforms: Record<string, string> } = { platforms: {} };
    const fallbackFile: string[] = [];
    const platformFile: Record<string, string> = {};
    for (const { file, descriptor: d } of mine) {
      if (d.default === undefined) continue;
      if (d.default === true) {
        if (defaults.fallback !== undefined) errors.push(`${label} has two defaults for every platform: ${fallbackFile[0]} and ${file}`);
        else {
          defaults.fallback = d.name;
          fallbackFile.push(file);
        }
        continue;
      }
      if (info.guard) {
        // A platform default would win over the guard's fallback on every zero-setup config: a second guard
        // plugin is used only when config names it.
        errors.push(`${label} is a guard: its one default is \`default: true\`, never per platform; select ${d.name} in config instead (${file})`);
        continue;
      }
      for (const p of d.default.platforms) {
        if (Object.hasOwn(defaults.platforms, p)) errors.push(`${label} has two defaults for ${p}: ${platformFile[p]} and ${file}`);
        else {
          defaults.platforms[p] = d.name;
          platformFile[p] = file;
        }
      }
    }
    if (!info.guard && !info.optional && !TOP_LEVEL_KINDS.includes(kind) && defaults.fallback === undefined) {
      const files = mine.length > 0 ? mine.map((f) => f.file).join(", ") : "no plugin files";
      errors.push(`${label} has no default plugin; mark one descriptor \`default: true\` (${files})`);
    }
    registry[kind] = { ...info, plugins, secrets, setups, connects, defaults };
  }
  if (errors.length > 0) throw new Error(`plugin registry: ${errors.join("; ")}`);
  return registry as unknown as Registry;
}

/** The built-in registry: every descriptor under PLUGIN_ROOT, loaded once at startup. */
export const REGISTRY: Registry = await loadRegistry([PLUGIN_ROOT]);

/**
 * A copy of `registry` with the pack plugins in `files` (design 11-packs.md), built for each config load; `registry`
 * itself never changes. A pack plugin is selected only by name: a guard (SecretStore, EgressScanner, ToolBroker),
 * a `default`, or a name its kind already has fails startup, naming the file. No files: `registry` itself.
 */
export async function withPackPlugins(registry: Registry, files: readonly string[]): Promise<Registry> {
  if (files.length === 0) return registry;
  const out = { ...registry } as Record<PluginKind, InterfaceEntry<PluginKind>>;
  for (const file of files) {
    const d = checkDescriptor(file, ((await import(pathToFileURL(file).href)) as { default?: unknown }).default);
    const entry = out[d.kind];
    const bad = (why: string) => new Error(`pack plugin ${file}: ${why} (docs/design/11-packs.md)`);
    if (entry.guard) {
      throw bad(`declares a ${entry.interface} (${d.kind}) plugin "${d.name}"; ${entry.interface} is a guard, and guards come only from the engine, never from a pack`);
    }
    if (d.default !== undefined) throw bad(`a pack plugin takes no default; select "${d.name}" at ${entry.configKey}`);
    if (Object.hasOwn(entry.plugins, d.name)) throw bad(`${entry.interface} (${d.kind}) already has a plugin named "${d.name}"`);
    if (d.connect && Object.values(entry.connects).some((c) => c.command === d.connect!.command)) {
      throw bad(`"setup ${d.kind} ${d.connect.command}" already connects another ${entry.interface} plugin`);
    }
    out[d.kind] = {
      ...entry,
      plugins: { ...entry.plugins, [d.name]: d.create as PluginFactory<PluginKind> },
      secrets: { ...entry.secrets, [d.name]: d.secrets ?? [] },
      setups: d.setup ? { ...entry.setups, [d.name]: d.setup } : entry.setups,
      connects: d.connect ? { ...entry.connects, [d.name]: d.connect } : entry.connects,
    };
  }
  return out as unknown as Registry;
}

/**
 * The plugin each `plugins` key falls back to when config leaves it out (or all of them when there is no
 * `plugins` object), from the descriptors' `default` fields. Only `awake` depends on the host today:
 * `caffeinate` on macOS, `none` everywhere else.
 */
export function defaultPlugins(
  platform: string = process.platform,
  registry: Registry = REGISTRY,
): Readonly<Partial<Record<(typeof PLUGINS_KEYS)[number], string>>> {
  const out: Partial<Record<PluginKind, string>> = {};
  for (const kind of PLUGINS_KEYS) {
    const d: KindDefaults = registry[kind].defaults;
    const name = Object.hasOwn(d.platforms, platform) ? d.platforms[platform] : d.fallback;
    if (name !== undefined) out[kind] = name;
  }
  return out;
}

/**
 * Throws unless `value` names a plugin registered for `kind` (optional kinds: selectPlugins skips an off value
 * before it gets here). For guards, any disabling value (missing,
 * null, false, "", "none", or anything that is not a registered name) fails with the guard message.
 */
export function checkPlugin(registry: Registry, kind: PluginKind, value: unknown): string {
  const entry = registry[kind];
  const names = Object.keys(entry.plugins);
  const available = `available: ${names.length > 0 ? names.join(", ") : "none"}${typeof value === "string" ? suggestion(value, names) : ""}`;
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

/** The kinds whose config key takes an ordered list of names: sources (design 2026-11-01), fallback chains. */
export const LIST_KINDS = ["source", "runner", "llm"] as const;
type ListKind = (typeof LIST_KINDS)[number];

/**
 * A list-taking key (`plugins.source`, design 2026-11-01; `plugins.runner` and `plugins.llm`, the fallback
 * chains of design 2026-11-07): one registered name, or a list of them. Returns the checked names in config
 * order. An unknown or non-string entry, or the same name twice fails, naming the key; so does an empty
 * `plugins.runner` or `plugins.llm`, while an empty `plugins.source` gives no source (issue #282). Which
 * source types the names build, and whether two share one, is known only once they are built: the controller
 * checks that at startup. The top-level `calendar` key (design 02-tasks) takes a list only, and an empty one gives
 * no calendar source.
 */
export function checkList(registry: Registry, kind: ListKind | "calendar", value: unknown): string[] {
  const entry = registry[kind];
  if (!Array.isArray(value)) {
    if (kind !== "calendar") return [checkPlugin(registry, kind, value)];
    throw new Error(`${entry.configKey} must be a list of ${entry.interface} plugin names (default []); available: ${Object.keys(entry.plugins).join(", ") || "none"}`);
  }
  // No source at all is allowed (issue #282): items and commands live in the store, messages wait in the outbox.
  // No calendar either: its default is [] (design 02-tasks).
  if (value.length === 0 && (kind === "source" || kind === "calendar")) return [];
  if (value.length === 0) {
    throw new Error(
      `${entry.configKey} is an empty list: name at least one ${entry.interface} plugin; available: ${Object.keys(entry.plugins).join(", ")}`,
    );
  }
  const out: string[] = [];
  for (const v of value) {
    const name = checkPlugin(registry, kind, v);
    if (out.includes(name)) throw new Error(`${entry.configKey} lists ${JSON.stringify(name)} twice; name each plugin once`);
    out.push(name);
  }
  return out;
}

/**
 * Turns the raw config into one checked plugin name per interface. No `plugins` object means the
 * defaults. A `plugins` object must name every guard explicitly; other interfaces fall back to defaults.
 */
export function selectPlugins(
  registry: Registry,
  raw: { store: { type: unknown }; calendar?: unknown; plugins?: unknown },
  opts: { platform?: string | undefined } = {},
): Selection {
  const defaults: Partial<Record<PluginKind, string>> = defaultPlugins(opts.platform, registry);
  let chosen: Record<string, unknown>;
  if (raw.plugins === undefined) chosen = { ...defaults };
  else {
    if (raw.plugins === null || typeof raw.plugins !== "object" || Array.isArray(raw.plugins)) {
      throw new Error("plugins must be an object mapping interface to plugin name (see docs/plugins.md)");
    }
    const given = raw.plugins as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(given)) {
      if (!(PLUGINS_KEYS as string[]).includes(key)) {
        const hint = (TOP_LEVEL_KINDS as readonly string[]).includes(key) ? `; ${key} is selected by the top-level "${key}" key` : "";
        problems.push(`unknown plugins key "${key}"${hint}; known keys: ${PLUGINS_KEYS.join(", ")}${suggestion(key, PLUGINS_KEYS)}`);
      }
    }
    if (problems.length > 0) throw new ConfigKeyError(problems);
    chosen = {};
    for (const key of PLUGINS_KEYS) {
      chosen[key] = Object.hasOwn(given, key) ? given[key] : registry[key].guard ? undefined : defaults[key];
    }
  }
  chosen.store = raw.store.type;
  const out = {} as Selection;
  for (const kind of PLUGIN_KINDS) {
    if ((LIST_KINDS as readonly string[]).includes(kind) || kind === "calendar") continue;
    // An optional kind left out or set to an off value selects nothing: the key stays out of the selection.
    if (registry[kind].optional && DISABLING.has(chosen[kind]) && !Object.hasOwn(registry[kind].plugins, chosen[kind] as string)) continue;
    out[kind] = checkPlugin(registry, kind, chosen[kind]);
  }
  // A list of one is the single name: the selection stays exactly what it always was.
  const lists = { source: "sources", runner: "runners", llm: "llms" } as const;
  for (const kind of LIST_KINDS) {
    const names = checkList(registry, kind, chosen[kind]);
    // An empty source list keeps `source` a string and makes `sources` the empty list selectedSources returns.
    out[kind] = names[0] ?? "";
    if (names.length !== 1) out[lists[kind]] = names;
  }
  // The top-level `calendar` key (design 02-tasks): a list of names, absent or [] (the default) for none.
  const calendars = raw.calendar === undefined ? [] : checkList(registry, "calendar", raw.calendar);
  if (calendars.length > 0) out.calendars = calendars;
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

/** The selected CalendarSource plugins (top-level `calendar`), built in config order, each with its name: none by default. */
export async function createCalendars(registry: Registry, selection: Selection, ctx: Contexts["calendar"]): Promise<{ name: string; source: Instances["calendar"] }[]> {
  const out = [];
  for (const name of selectedCalendars(selection)) out.push({ name, source: await createPlugin(registry, "calendar", name, ctx) });
  return out;
}

/**
 * A copy of `registry` with one more plugin, and the secrets it declares (none if left out). For tests;
 * in-repo plugins are descriptor files instead. Never a default.
 */
export function withPlugin<K extends PluginKind>(
  registry: Registry,
  kind: K,
  name: string,
  factory: PluginFactory<K>,
  secrets: readonly SecretDeclaration[] = [],
): Registry {
  const entry = registry[kind] as InterfaceEntry<K>;
  if (entry.guard && DISABLING.has(name)) throw new Error(`"${name}" cannot name a ${entry.interface} plugin: it means disabled`);
  return {
    ...registry,
    [kind]: { ...entry, plugins: { ...entry.plugins, [name]: factory }, secrets: { ...entry.secrets, [name]: secrets } },
  };
}
