// The capability list (design 08-settings, 2026-11-16): GET /api/v1/settings/capabilities lists the skills in the
// configured skill folders and the imported ones (`ext_skill_refs` pointers, each read from its SKILL.md now; one whose
// file is missing or changed is listed but not enabled), the ToolBroker's tools and the provider entries (each registered LLM provider and agent
// runner, one per configured endpoint), with whether each is enabled, the roles that may use it and when a stored run
// last used it. The Settings page shows its providers; the Plugins page's Skills and Tools tabs come from the same
// builder (capabilityRows) through plugins-api.ts. Read only: grants change through the `tool_grants` setting.
//
// Names only, never a value: the sources are folder listings, tool descriptors and plugin names (capabilitySources),
// an endpoint is shown as its host, and every string leaves through the Withholder. The broker is built here only to
// read its descriptor table (allTools): its forge client, credentials, secrets and scanner are stand-ins that throw if
// touched, and nothing here calls a tool (G2). "Last used" reads stored runs and transcripts, and writes nothing.

import { TextDecoder } from "node:util";
import type { Loaded } from "../load-config.js";
import { GRANT_RUN_KINDS, capabilitiesConfig } from "../core/config.js";
import { MODEL_RUN_KINDS } from "../core/model-choice.js";
import { type SettingsBase, resolveSettings } from "../core/settings.js";
import type { Run, RunKind } from "../core/types.js";
import { harnessToolName } from "../impl/runner/tool-bridge.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type SharedStorage, readRange } from "../interfaces/shared-storage.js";
import type { ToolBroker } from "../interfaces/tool-broker.js";
import {
  type Capability, type CapabilitySources, type ProviderSource, type Skill, type SkillRef, type StoredRun, type ToolSource,
  capabilityList, grantName, lastUsed, providerId, providerRoles, readSkillRefs, readSkills, skillFolderPath, toolId,
} from "../runtime/capabilities/capabilities.js";
import type { UiDeps } from "./deps.js";
import type { UiSettings } from "./settings-api.js";
import { itemPrefix, runParts } from "./transcript.js";
import { Withholder } from "./withhold.js";

/** Stored runs read for "last used": those finished in the last 30 days, newest first, at most this many. */
const USAGE_RUNS = 100;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The windows read in turn until one holds USAGE_RUNS finished runs; the last is USAGE_WINDOW_MS. Newest first in
 * each, so a short window that is full gives the same runs as the long one, without reading thousands of rows.
 */
const USAGE_WINDOWS_MS = [24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, USAGE_WINDOW_MS];
/** The most transcript bytes read per run part. */
const TRANSCRIPT_BYTES = 1024 * 1024;

/** The roles of each provider interface: an agent runner runs the agent roles; an LLM provider makes the improve run's plain calls. */
const RUNNER_ROLES: readonly string[] = MODEL_RUN_KINDS;
const LLM_ROLES: readonly string[] = ["improve"] satisfies readonly RunKind[];

/** A provider entry before the read: `models` null means the `models` setting's names, resolved per request. */
export type ProviderEntry = Omit<ProviderSource, "models"> & { models: Readonly<Record<string, string>> | null };

/** What the registry is built from, as the loaded config gives it. */
export type UiCapabilitySources = Omit<CapabilitySources, "providers"> & { providers: readonly ProviderEntry[] };

/** A stand-in for a dependency the broker's listing never touches: any use throws. */
const untouched = (what: string): never =>
  new Proxy({}, { get: (_t, p) => { throw new Error(`capabilities: the ${what} is not available to the tool listing (${String(p)})`); } }) as never;

/** The selected broker's tools (its descriptor table), or none when it cannot be built here. */
async function brokerTools(loaded: Pick<Loaded, "registry" | "plugins" | "config">, store: FactoryStore): Promise<ToolSource[]> {
  const { createPlugin } = await import("../plugins.js"); // loaded when asked: the registry loads every plugin
  try {
    const { owner, name } = loaded.config.repo;
    const ctx = {
      loaded: loaded as Loaded, repo: { owner, name }, extraScanValues: [], store,
      github: untouched("forge client"), credentials: untouched("forge credential"), secrets: untouched("secret store"), scanner: untouched("egress scanner"), clock: untouched("clock"),
    };
    const broker: ToolBroker = await createPlugin(loaded.registry, "broker", loaded.plugins.broker, ctx);
    return broker.allTools().map((t) => ({ name: t.name, description: t.description, read_only: t.read_only, origin: "broker" as const }));
  } catch {
    return [];
  }
}

/** The host of an endpoint URL, never its path, query or user info; null when it is not a URL. */
function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The capability sources of the loaded config: the skill folders (`capabilities.skill_folders`, resolved from the factory
 * root), the broker's and the pack layers' tools, and every registered runner and LLM plugin. A plugin with its own config
 * block (the block named after it, `openai_compatible` for `openai-compatible`) is that endpoint: its host and its
 * `models`; any other uses the `models` setting.
 */
export async function capabilitySources(
  loaded: Pick<Loaded, "root" | "file" | "registry" | "plugins" | "config" | "pack_tools">,
  store: FactoryStore,
): Promise<UiCapabilitySources> {
  const { selectedLlms, selectedRunners } = await import("../plugins.js");
  const file = loaded.file as unknown as Record<string, unknown>;
  const selected = { runner: selectedRunners(loaded.plugins), llm: selectedLlms(loaded.plugins) };
  const providers: ProviderEntry[] = [];
  for (const iface of ["runner", "llm"] as const) {
    for (const plugin of Object.keys(loaded.registry[iface].plugins).sort()) {
      const block = file[plugin.replaceAll("-", "_")];
      const own = isObject(block) && isObject(block.models) ? (Object.fromEntries(Object.entries(block.models).filter(([, m]) => typeof m === "string")) as Record<string, string>) : null;
      providers.push({ interface: iface, plugin, selected: selected[iface].includes(plugin), endpoint: isObject(block) ? hostOf(block.base_url) : null, models: own });
    }
  }
  const pack: ToolSource[] = (loaded.pack_tools ?? []).map((t) => ({ name: t.name, description: t.description, read_only: t.read_only, origin: "pack" }));
  return {
    skill_folders: capabilitiesConfig(loaded.file).skill_folders.map((f) => skillFolderPath(f, loaded.root)),
    tools: [...(await brokerTools(loaded, store)), ...pack],
    providers,
  };
}

const NO_SOURCES: UiCapabilitySources = { skill_folders: [], tools: [], providers: [] };

/** The sources the Settings wiring reads, again on each call; none without the config file's writer. */
export const settingsSources = async (s: Pick<UiSettings, "editFile">): Promise<UiCapabilitySources> => (await s.editFile?.capabilities?.()) ?? NO_SOURCES;

/** The imported skills: every stored `ext_skill_refs` pointer of kind `skill`, read from its file now (readSkillRefs). Reads only. */
async function importedSkills(store: FactoryStore): Promise<Skill[]> {
  const rows = await storeSql(store).all("SELECT source, kind, name, path, sha256 FROM ext_skill_refs WHERE kind = 'skill'");
  return readSkillRefs(rows.map((r) => ({ source: String(r.source), kind: String(r.kind), name: String(r.name), path: String(r.path), sha256: String(r.sha256) }) satisfies SkillRef));
}

/** The model a finished run's usage reports, or null. */
function runModel(run: Run): string | null {
  const o = run.outcome;
  const usage = o?.status === "succeeded" ? (o.data.usage as { model?: unknown } | undefined) : o?.usage;
  return typeof usage?.model === "string" ? usage.model : null;
}

/** A run's stored transcript parts, joined (each part cut at TRANSCRIPT_BYTES); null when none is stored. */
async function transcriptText(d: Pick<UiDeps, "storage">, item: string, run: StoredRun): Promise<string | null> {
  const storage = d.storage;
  if (!storage) return null;
  const keys = await storage.list(itemPrefix(item as Run["work_item_id"]));
  const parts = runParts(keys, item as Run["work_item_id"], run.id);
  if (parts.length === 0) return null;
  const decoder = new TextDecoder("utf-8");
  const texts = [];
  for (const part of parts) {
    const r = await readRange(storage, `${itemPrefix(item as Run["work_item_id"])}${run.id}${part ? `.${part}` : ""}.json`, 0, TRANSCRIPT_BYTES);
    if (r) texts.push(decoder.decode(r.bytes));
  }
  return texts.join("\n");
}

/**
 * Per storage, per finished run: the markers already looked for in its stored transcript and whether it holds each.
 * A finished run's transcript does not change, so a later request reads it again only for a marker it was never
 * searched for (a new skill or tool). A run with no transcript is not remembered: its transcript may still land.
 */
const runMarkers = new WeakMap<SharedStorage, Map<string, Map<string, boolean>>>();

/** The run marker memory of `storage`, holding only `runs` (the rest left the read window). */
function markerMemory(storage: SharedStorage, runs: readonly StoredRun[]): Map<string, Map<string, boolean>> {
  let memory = runMarkers.get(storage);
  if (!memory) runMarkers.set(storage, (memory = new Map()));
  const keep = new Set(runs.map((r) => r.id));
  for (const id of memory.keys()) if (!keep.has(id)) memory.delete(id);
  return memory;
}

/** Which of `markers` the run's stored transcript holds (read only for markers not yet looked for); null when it has none. */
async function transcriptHolds(
  d: Pick<UiDeps, "storage">, memory: Map<string, Map<string, boolean>>, item: string, run: StoredRun, markers: readonly string[],
): Promise<ReadonlySet<string> | null> {
  const known = memory.get(run.id) ?? new Map<string, boolean>();
  const unknown = markers.filter((m) => !known.has(m));
  if (unknown.length > 0) {
    const text = await transcriptText(d, item, run);
    if (text === null) return null;
    for (const m of unknown) known.set(m, text.includes(m));
    memory.set(run.id, known);
  }
  return new Set(markers.filter((m) => known.get(m) === true));
}

/** The newest USAGE_RUNS runs finished within USAGE_WINDOW_MS, newest first: the shortest window that holds them is read. */
async function recentFinishedRuns(store: Pick<FactoryStore, "listRunsFinishedWithin">): Promise<Run[]> {
  let runs: Run[] = [];
  for (const window of USAGE_WINDOWS_MS) {
    runs = (await store.listRunsFinishedWithin(window)).filter((r) => r.finished_at !== null);
    if (runs.length >= USAGE_RUNS) break;
  }
  return runs.slice(0, USAGE_RUNS);
}

/** What the list is read with: the store (runs, overrides), the scanner (the Withholder) and the transcript storage. */
export type CapabilityDeps = Pick<UiDeps, "store" | "scanner" | "storage">;

/** The capability list of `sources` with the settings in force over `base`, every string through the Withholder. */
export async function capabilityRows(d: CapabilityDeps, base: SettingsBase, sources: UiCapabilitySources): Promise<Capability[]> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const values = resolveSettings(base, await d.store.listSettingOverrides()).values;
  const providers: ProviderSource[] = sources.providers.map((p) => ({ ...p, models: p.models ?? values.models }));
  const roles = { runner_roles: RUNNER_ROLES, llm_roles: LLM_ROLES };

  const finished = await recentFinishedRuns(d.store);
  const items = new Map(finished.map((r) => [r.id as string, r.work_item_id as string]));
  const runs: StoredRun[] = finished.map((r) => ({ id: r.id, kind: r.kind, finished_at: r.finished_at!, model: runModel(r) }));
  const skills = [...(await readSkills(sources.skill_folders)), ...(await importedSkills(d.store))];
  const markers = new Map<string, string[]>([
    ...skills.map((k): [string, string[]] => [`skill:${k.name}`, [`"skill":"${k.name}"`]]),
    ...sources.tools.map((t): [string, string[]] => [toolId(t), [harnessToolName(grantName(t))]]),
  ]);
  const memory = d.storage ? markerMemory(d.storage, runs) : null;
  const used = await lastUsed(
    runs,
    providers.filter((p) => p.selected).map((p) => ({ id: providerId(p), roles: providerRoles(p, roles), models: Object.values(p.models) })),
    markers,
    async (run, wanted) => (memory === null ? null : transcriptHolds(d, memory, items.get(run.id)!, run, wanted)),
  );
  const list = capabilityList({ skills, sources: { tools: sources.tools, providers }, grants: values.tool_grants, ...roles, last_used: used });

  const capabilities: Capability[] = [];
  for (const c of list) {
    capabilities.push({
      ...c,
      id: await text(c.id),
      name: await text(c.name),
      detail: c.detail === null ? null : await text(c.detail),
      ...(c.description === undefined ? {} : { description: c.description === null ? null : await text(c.description) }),
      ...(c.imported ? { imported: { ...c.imported, path: await text(c.imported.path) } } : {}),
      ...(c.models ? { models: await Promise.all(c.models.map(async (m) => ({ class: m.class, model: await text(m.model) }))) } : {}),
    });
  }
  return capabilities;
}

/** GET /api/v1/settings/capabilities: the list, every string through the Withholder. */
export async function readCapabilities(d: UiDeps, s: UiSettings) {
  return {
    as_of: d.clock.now().toISOString(),
    /** The roles a tool may be granted to (`tool_grants` keys). */
    roles: GRANT_RUN_KINDS,
    capabilities: await capabilityRows(d, s.base, await settingsSources(s)),
  };
}
