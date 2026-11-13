// The capabilities registry (design 08-settings, 2026-11-13): one list of what the factory's agents may use, for the
// Settings page's Capabilities section. Three kinds today: the skills in the configured skill folders, the tools the
// ToolBroker serves (with pack tools), and the LLM provider and agent runner entries, one per configured endpoint.
// MCP servers join when packs carry them (#495).
//
// Names only: the registry reads folder listings, tool descriptors and plugin selections, never a secret, a file's
// content or a credential. "Last used" comes from runs already stored (their finish time, their reported model and
// their stored transcript), so a tool call writes nothing new. Pure but for the skill folder listing.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type CapabilityKind = "skill" | "tool" | "provider";

/** A tool the broker serves: its descriptor's name, description and read-only flag. `pack`: a pack layer's tool. */
export interface ToolSource {
  name: string;
  description: string;
  read_only: boolean;
  origin: "broker" | "pack";
}

/**
 * One provider entry: a registered LLMProvider (`llm`) or AgentRunner (`runner`) plugin, and whether config selects
 * it. `endpoint`: the host it calls, or null for a local CLI. `models`: the model name per class, the classes
 * `model_by` names; a run's class resolves to the model of the entry that serves it.
 */
export interface ProviderSource {
  interface: "llm" | "runner";
  plugin: string;
  selected: boolean;
  endpoint: string | null;
  models: Readonly<Record<string, string>>;
}

/** What the registry is built from: names and descriptors only. */
export interface CapabilitySources {
  /** Absolute folders, in config order. */
  skill_folders: readonly string[];
  tools: readonly ToolSource[];
  providers: readonly ProviderSource[];
}

export interface Skill {
  name: string;
  folder: string;
}

export interface Capability {
  kind: CapabilityKind;
  /** `skill:<name>`, `tool:<name>`, `llm:<plugin>` or `runner:<plugin>`: what a provider entry is named by. */
  id: string;
  name: string;
  /** The skill's folder, the tool's description, or the provider's endpoint; null when there is none. */
  detail: string | null;
  enabled: boolean;
  /** The roles (run kinds) that may use it. */
  roles: string[];
  /** The newest stored run that used it, by finish time; null when none of the runs read did. */
  last_used: string | null;
  /** A tool: whether it is read-only (only read-only tools reach an agent). */
  read_only?: boolean;
  /** A provider: the model per class (`model_by`'s values). */
  models?: { class: string; model: string }[];
}

/** The owner's HOME for a leading `~`; a relative folder is taken from `root`. */
export function skillFolderPath(folder: string, root: string, home: string = homedir()): string {
  if (folder === "~" || folder.startsWith("~/")) return join(home, folder.slice(1));
  return isAbsolute(folder) ? folder : resolve(root, folder);
}

/**
 * The skills in each folder: a subfolder with a `SKILL.md` (Claude Code's layout), or a top-level `<name>.md` (a
 * pack's `skills/` layout). Only names are read. A folder that is missing or unreadable lists none.
 */
export async function readSkills(folders: readonly string[]): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const folder of folders) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        const inner = await readdir(join(folder, e.name)).catch(() => [] as string[]);
        if (inner.includes("SKILL.md")) out.push({ name: e.name, folder });
      } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") {
        out.push({ name: e.name.slice(0, -".md".length), folder });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder));
}

/** One stored run, as the registry reads it: newest first. `model`: the model its usage reports, null when none. */
export interface StoredRun {
  id: string;
  kind: string;
  finished_at: string;
  model: string | null;
}

/**
 * When each capability was last used, from stored runs only (newest first):
 * - a provider entry: the newest run of one of its roles whose reported model is one of the entry's model names;
 * - a skill or tool: the newest run whose stored transcript holds one of its markers (`markers`, by capability id).
 * `transcript(run)` reads one run's stored transcript, null when it has none; it is asked only while a marker is unfound.
 */
export async function lastUsed(
  runs: readonly StoredRun[],
  providers: readonly { id: string; roles: readonly string[]; models: readonly string[] }[],
  markers: ReadonlyMap<string, readonly string[]>,
  transcript: (run: StoredRun) => Promise<string | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of providers) {
    const names = p.models.map((m) => m.toLowerCase()).filter((m) => m !== "");
    const run = runs.find((r) => p.roles.includes(r.kind) && r.model !== null && names.some((m) => r.model!.toLowerCase().includes(m)));
    if (run) out.set(p.id, run.finished_at);
  }
  const open = new Map([...markers].filter(([, m]) => m.length > 0));
  for (const run of runs) {
    if (open.size === 0) break;
    const text = await transcript(run);
    if (text === null) continue;
    for (const [id, m] of open) {
      if (!m.some((x) => text.includes(x))) continue;
      out.set(id, run.finished_at);
      open.delete(id);
    }
  }
  return out;
}

/** What the list is built from beside the sources: the grants in force, the roles, and the last-used times. */
export interface CapabilityInputs {
  skills: readonly Skill[];
  sources: Pick<CapabilitySources, "tools" | "providers">;
  /** The `tool_grants` in force: run kind → tool names. */
  grants: Readonly<Record<string, readonly string[] | undefined>>;
  /** The roles that run an agent (a runner entry's roles) and those that make one plain model call (an LLM entry's). */
  runner_roles: readonly string[];
  llm_roles: readonly string[];
  last_used: ReadonlyMap<string, string>;
}

/** A tool's id; a pack tool is granted and called as `pack:tool:<name>`. */
export const toolId = (t: Pick<ToolSource, "name" | "origin">): string => `tool:${grantName(t)}`;
/** The name `tool_grants` gives a tool. */
export const grantName = (t: Pick<ToolSource, "name" | "origin">): string => (t.origin === "pack" ? `pack:tool:${t.name}` : t.name);
export const providerId = (p: Pick<ProviderSource, "interface" | "plugin">): string => `${p.interface}:${p.plugin}`;
export const providerRoles = (p: Pick<ProviderSource, "interface">, i: Pick<CapabilityInputs, "runner_roles" | "llm_roles">): readonly string[] =>
  p.interface === "runner" ? i.runner_roles : i.llm_roles;

/**
 * The Capabilities list: skills, then tools, then providers. A skill in a configured folder is enabled; no role grant
 * exists for skills, so it names no role. A tool is enabled when a role is granted it; a tool that is not read-only
 * never reaches an agent. A provider entry is enabled when config selects it, for the roles of its interface.
 */
export function capabilityList(i: CapabilityInputs): Capability[] {
  const used = (id: string) => i.last_used.get(id) ?? null;
  const skills: Capability[] = i.skills.map((s) => ({ kind: "skill", id: `skill:${s.name}`, name: s.name, detail: s.folder, enabled: true, roles: [], last_used: used(`skill:${s.name}`) }));
  const tools: Capability[] = i.sources.tools.map((t) => {
    const roles = Object.entries(i.grants).filter(([, names]) => t.read_only && (names ?? []).includes(grantName(t))).map(([kind]) => kind).sort();
    return { kind: "tool", id: toolId(t), name: grantName(t), detail: t.description, enabled: roles.length > 0, roles, last_used: used(toolId(t)), read_only: t.read_only };
  });
  const providers: Capability[] = i.sources.providers.map((p) => ({
    kind: "provider",
    id: providerId(p),
    name: providerId(p),
    detail: p.endpoint,
    enabled: p.selected,
    roles: p.selected ? [...providerRoles(p, i)] : [],
    last_used: used(providerId(p)),
    models: Object.entries(p.models).map(([cls, model]) => ({ class: cls, model })),
  }));
  return [...skills, ...tools, ...providers];
}
