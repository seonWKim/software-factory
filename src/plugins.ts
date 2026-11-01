// Plugin registry (design D6): every implementation of an infra interface is a named plugin, chosen by
// name in factory.config.json. Each plugin describes itself in a `*.plugin.ts` file beside its
// implementation under src/impl/ (`export default definePlugin({...})`, src/plugin-api.ts). At startup the
// loader below finds those files (`*.plugin.js` once built), sorts them by path, imports each and fills
// REGISTRY. This file names no plugin and imports no implementation: only a new interface edits it.
// src/compose.ts, src/canary.ts and src/setup.ts resolve plugins through it; docs/plugins.md describes
// each one and `tests/plugins.test.ts` keeps the two in step.
//
// Guards (SecretStore, EgressScanner, ToolBroker; docs/architecture.md §5, G1–G6) can be switched to
// another plugin, but never disabled: config that selects nothing for a guard fails at startup.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigKeyError, suggestion } from "./config-keys.js";
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
} from "./plugin-api.js";
export { declaredSecretNames, declaredSecrets, definePlugin, selectedSources } from "./plugin-api.js";

interface KindInfo {
  /** The interface's TypeScript name; also its heading in docs/plugins.md. */
  interface: string;
  /** Where config selects it, for error messages. */
  configKey: string;
  /** Guards can be switched but never disabled (architecture §5). */
  guard: boolean;
}

/** The interfaces, in order. A new interface is the only reason to edit this file. */
const KINDS: { readonly [K in PluginKind]: KindInfo } = {
  store: { interface: "FactoryStore", configKey: "store.type", guard: false },
  sandbox: { interface: "Sandbox", configKey: "plugins.sandbox", guard: false },
  runner: { interface: "AgentRunner", configKey: "plugins.runner", guard: false },
  llm: { interface: "LLMProvider", configKey: "plugins.llm", guard: false },
  auth: { interface: "AuthProvider", configKey: "auth", guard: false },
  secrets: { interface: "SecretStore", configKey: "plugins.secrets", guard: true },
  egress: { interface: "EgressScanner", configKey: "plugins.egress", guard: true },
  broker: { interface: "ToolBroker", configKey: "plugins.broker", guard: true },
  storage: { interface: "SharedStorage", configKey: "plugins.storage", guard: false },
  source: { interface: "SourceAdapter", configKey: "plugins.source", guard: false },
  capability: { interface: "CapabilitySearch", configKey: "plugins.capability", guard: false },
  clock: { interface: "Clock", configKey: "plugins.clock", guard: false },
  updater: { interface: "Updater", configKey: "plugins.updater", guard: false },
  awake: { interface: "KeepAwake", configKey: "plugins.awake", guard: false },
  github_auth: { interface: "GitHubCredentials", configKey: "plugins.github_auth", guard: false },
};

export const PLUGIN_KINDS = Object.keys(KINDS) as PluginKind[];

/** Store and auth are selected by their own top-level config keys, so they take no default. */
const TOP_LEVEL_KINDS: readonly PluginKind[] = ["store", "auth"];

/** The interfaces selected under the `plugins` config object. Store and auth keep their own keys. */
export const PLUGINS_KEYS = PLUGIN_KINDS.filter((k) => !TOP_LEVEL_KINDS.includes(k));

/** Values that mean "turn this off". Never accepted for a guard. */
const DISABLING = new Set<unknown>([undefined, null, false, "", "none"]);

/** Where the built-in descriptors live: src/impl in the source tree, dist/impl once built. */
export const IMPL_DIR = join(import.meta.dirname, "impl");

/** `*.plugin.ts` (source) or `*.plugin.js` (built); never a `*.d.ts`. */
const DESCRIPTOR_FILE = /\.plugin\.(?:ts|js)$/;

/** Every descriptor file under `dirs`, recursively, sorted by path so registration order is stable. */
export function findPluginFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && DESCRIPTOR_FILE.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
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
  const { kind, name, create, secrets, default: dflt } = d as Record<string, unknown>;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) {
    throw bad(`unknown kind ${JSON.stringify(kind)}; known kinds: ${PLUGIN_KINDS.join(", ")}`);
  }
  const info = KINDS[kind as PluginKind];
  if (typeof name !== "string" || name === "") throw bad("name must be a non-empty string");
  if (info.guard && DISABLING.has(name)) throw bad(`"${name}" cannot name a ${info.interface} plugin: it means disabled`);
  if (typeof create !== "function") throw bad("create must be a function");
  if (secrets !== undefined && !Array.isArray(secrets)) throw bad("secrets must be a list");
  if (dflt !== undefined) {
    if (TOP_LEVEL_KINDS.includes(kind as PluginKind)) {
      throw bad(`${kind} plugins take no default: the top-level "${info.configKey}" config key always picks one`);
    }
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
      for (const p of d.default.platforms) {
        if (Object.hasOwn(defaults.platforms, p)) errors.push(`${label} has two defaults for ${p}: ${platformFile[p]} and ${file}`);
        else {
          defaults.platforms[p] = d.name;
          platformFile[p] = file;
        }
      }
    }
    if (!info.guard && !TOP_LEVEL_KINDS.includes(kind) && defaults.fallback === undefined) {
      const files = mine.length > 0 ? mine.map((f) => f.file).join(", ") : "no plugin files";
      errors.push(`${label} has no default plugin; mark one descriptor \`default: true\` (${files})`);
    }
    registry[kind] = { ...info, plugins, secrets, defaults };
  }
  if (errors.length > 0) throw new Error(`plugin registry: ${errors.join("; ")}`);
  return registry as unknown as Registry;
}

/** The built-in registry: every descriptor under IMPL_DIR, loaded once at startup. */
export const REGISTRY: Registry = await loadRegistry([IMPL_DIR]);

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
 * Throws unless `value` names a plugin registered for `kind`. For guards, any disabling value (missing,
 * null, false, "", "none", or anything that is not a registered name) fails with the guard message.
 */
export function checkPlugin(registry: Registry, kind: PluginKind, value: unknown): string {
  const entry = registry[kind];
  const names = Object.keys(entry.plugins);
  const available = `available: ${names.join(", ")}${typeof value === "string" ? suggestion(value, names) : ""}`;
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
 * `plugins.source` (design 2026-11-01): one registered name, or a list of them. Returns the checked names in
 * config order. An empty list, an unknown or non-string entry, or the same name twice fails. Which source
 * types the names build, and whether two share one, is known only once they are built: the controller checks
 * that at startup.
 */
export function checkSources(registry: Registry, value: unknown): string[] {
  if (!Array.isArray(value)) return [checkPlugin(registry, "source", value)];
  const entry = registry.source;
  if (value.length === 0) {
    throw new Error(
      `${entry.configKey} is an empty list: name at least one ${entry.interface} plugin; available: ${Object.keys(entry.plugins).join(", ")}`,
    );
  }
  const out: string[] = [];
  for (const v of value) {
    const name = checkPlugin(registry, "source", v);
    if (out.includes(name)) throw new Error(`${entry.configKey} lists ${JSON.stringify(name)} twice; name each source once`);
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
  raw: { store: { type: unknown }; auth: unknown; plugins?: unknown },
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
        const hint = key === "store" || key === "auth" ? `; ${key} is selected by the top-level "${key}" key` : "";
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
  chosen.auth = raw.auth;
  const out = {} as Selection;
  for (const kind of PLUGIN_KINDS) {
    if (kind !== "source") out[kind] = checkPlugin(registry, kind, chosen[kind]);
  }
  // A list of one is the single name: the selection stays exactly what it always was.
  const sources = checkSources(registry, chosen.source);
  out.source = sources[0]!;
  if (sources.length > 1) out.sources = sources;
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
