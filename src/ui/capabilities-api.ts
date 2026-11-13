// The Settings page's Capabilities section (design 08-settings, 2026-11-13): GET /api/v1/settings/capabilities lists
// the skills in the configured skill folders, the ToolBroker's tools and the provider entries (each registered LLM
// provider and agent runner, one per configured endpoint), with whether each is enabled, the roles that may use it and
// when a stored run last used it. Read only: grants change through the `tool_grants` setting (POST /api/v1/settings).
//
// Names only, never a value: the sources are folder listings, tool descriptors and plugin names (capabilitySources),
// an endpoint is shown as its host, and every string leaves through the Withholder. The broker is built here only to
// read its descriptor table (allTools): its forge client, credentials, secrets and scanner are stand-ins that throw if
// touched, and nothing here calls a tool (G2). "Last used" reads stored runs and transcripts, and writes nothing.

import { TextDecoder } from "node:util";
import type { Loaded } from "../compose.js";
import { GRANT_RUN_KINDS, capabilitiesConfig } from "../core/config.js";
import { MODEL_RUN_KINDS } from "../core/model-choice.js";
import { resolveSettings } from "../core/settings.js";
import type { Run, RunKind } from "../core/types.js";
import { harnessToolName } from "../impl/runner/tool-bridge.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { readRange } from "../interfaces/shared-storage.js";
import type { ToolBroker } from "../interfaces/tool-broker.js";
import {
  type Capability, type CapabilitySources, type ProviderSource, type StoredRun, type ToolSource,
  capabilityList, grantName, lastUsed, providerId, providerRoles, readSkills, skillFolderPath, toolId,
} from "../runtime/capabilities/capabilities.js";
import type { UiDeps } from "./pages.js";
import type { UiSettings } from "./settings-api.js";
import { itemPrefix, runParts } from "./transcript.js";
import { Withholder } from "./withhold.js";

export const CAPABILITIES_PATH = "/api/v1/settings/capabilities";
/** Stored runs read for "last used": those finished in the last 30 days, newest first, at most this many. */
export const USAGE_RUNS = 100;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
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

/** The model a finished run's usage reports, or null. */
function runModel(run: Run): string | null {
  const o = run.outcome;
  const usage = o?.status === "succeeded" ? (o.data.usage as { model?: unknown } | undefined) : o?.usage;
  return typeof usage?.model === "string" ? usage.model : null;
}

/** A run's stored transcript parts, joined (each part cut at TRANSCRIPT_BYTES); null when none is stored. */
async function transcriptText(d: UiDeps, item: string, run: StoredRun): Promise<string | null> {
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

/** GET /api/v1/settings/capabilities: the list, every string through the Withholder. */
export async function readCapabilities(d: UiDeps, s: UiSettings) {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const sources = (await s.editFile?.capabilities?.()) ?? NO_SOURCES;
  const values = resolveSettings(s.base, await d.store.listSettingOverrides()).values;
  const providers: ProviderSource[] = sources.providers.map((p) => ({ ...p, models: p.models ?? values.models }));
  const roles = { runner_roles: RUNNER_ROLES, llm_roles: LLM_ROLES };

  const finished = (await d.store.listRunsFinishedWithin(USAGE_WINDOW_MS)).filter((r) => r.finished_at !== null).slice(0, USAGE_RUNS);
  const items = new Map(finished.map((r) => [r.id as string, r.work_item_id as string]));
  const runs: StoredRun[] = finished.map((r) => ({ id: r.id, kind: r.kind, finished_at: r.finished_at!, model: runModel(r) }));
  const skills = await readSkills(sources.skill_folders);
  const markers = new Map<string, string[]>([
    ...skills.map((k): [string, string[]] => [`skill:${k.name}`, [`"skill":"${k.name}"`]]),
    ...sources.tools.map((t): [string, string[]] => [toolId(t), [harnessToolName(grantName(t))]]),
  ]);
  const used = await lastUsed(
    runs,
    providers.filter((p) => p.selected).map((p) => ({ id: providerId(p), roles: providerRoles(p, roles), models: Object.values(p.models) })),
    markers,
    (run) => transcriptText(d, items.get(run.id)!, run),
  );
  const list = capabilityList({ skills, sources: { tools: sources.tools, providers }, grants: values.tool_grants, ...roles, last_used: used });

  const capabilities: Capability[] = [];
  for (const c of list) {
    capabilities.push({
      ...c,
      id: await text(c.id),
      name: await text(c.name),
      detail: c.detail === null ? null : await text(c.detail),
      ...(c.models ? { models: await Promise.all(c.models.map(async (m) => ({ class: m.class, model: await text(m.model) }))) } : {}),
    });
  }
  return {
    as_of: d.clock.now().toISOString(),
    /** The roles a tool may be granted to (`tool_grants` keys). */
    roles: GRANT_RUN_KINDS,
    capabilities,
  };
}
