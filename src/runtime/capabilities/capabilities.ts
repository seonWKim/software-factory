// The capabilities registry (design 08-settings, 2026-11-16): one list of what the factory's agents may use, for the
// Plugins page's Skills and Tools tabs and the Settings page's Providers section. Three kinds: the skills in the
// configured skill folders and the skills imported from Claude Code and Codex (`ext_skill_refs` pointers, design
// 11-plugin-import), the tools the ToolBroker serves (with pack tools), and the LLM provider and agent runner entries,
// one per configured endpoint. Pack MCP servers are listed beside them by src/ui/plugins-api.ts.
//
// Names only: the registry reads folder listings, a skill file's front matter description, tool descriptors and
// plugin selections, never a secret, a skill file's body or a credential. An imported skill is read from its file each
// time (readSkillRefs): its bytes are hashed against the stored SHA-256 and only its front matter description is kept.
// "Last used" comes from runs already stored (their finish time, their reported model and their stored transcript), so
// a tool call writes nothing new. Pure but for the skill folder listing and the skill file reads.

import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** Where an imported skill was found: Claude Code's or Codex's user-level skills. */
export type SkillRefSource = "claude" | "codex";

/**
 * An imported skill's state, read from its file at read time: `ok` (its bytes still hash to the stored SHA-256),
 * `missing` (the file is gone or unreadable) or `changed` (it hashes to something else; import it again).
 */
export type SkillState = "ok" | "missing" | "changed";

export interface Skill {
  name: string;
  folder: string;
  /** The `description` of the skill file's front matter; null when it has none. */
  description: string | null;
  /** An imported skill only: its source, its SKILL.md path and its state. A folder skill has none of these. */
  imported?: { source: SkillRefSource; path: string; state: SkillState };
}

/** One `ext_skill_refs` row, as the registry reads it. */
export interface SkillRef {
  source: SkillRefSource;
  name: string;
  /** The absolute path of its SKILL.md. */
  path: string;
  sha256: string;
  created_at: string;
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
  /** A skill: its front matter description (null: none). */
  description?: string | null;
  /** An imported skill: its source, SKILL.md path and state (only `ok` is enabled). */
  imported?: Skill["imported"];
  /** A tool: whether it is read-only (only read-only tools reach an agent). */
  read_only?: boolean;
  /** A tool: the broker's, or a pack layer's. */
  origin?: ToolSource["origin"];
  /** A provider: the model per class (`model_by`'s values). */
  models?: { class: string; model: string }[];
}

/** The owner's HOME for a leading `~`; a relative folder is taken from `root`. */
export function skillFolderPath(folder: string, root: string, home: string = homedir()): string {
  if (folder === "~" || folder.startsWith("~/")) return join(home, folder.slice(1));
  return isAbsolute(folder) ? folder : resolve(root, folder);
}

/** The most bytes of a skill file read for its front matter: the body past it is never returned. */
const FRONT_MATTER_BYTES = 16 * 1024;
/** The longest description kept. */
const DESCRIPTION_CHARS = 500;

/**
 * The `description` of a skill file's front matter (the block between a first line `---` and the next `---`), or
 * null when there is no front matter or no description in it. Takes `description: text`, a quoted value, and a
 * folded or literal block (`>` or `|`, then indented lines). Text outside the front matter is never read.
 */
export function frontMatterDescription(text: string): string | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const block = lines.slice(1, end);
  const at = block.findIndex((l) => /^description\s*:/.test(l));
  if (at < 0) return null;
  let value = block[at]!.replace(/^description\s*:\s*/, "").trim();
  if (/^[>|][+-]?$/.test(value) || value === "") {
    const rest: string[] = [];
    for (const l of block.slice(at + 1)) {
      if (!/^\s+\S/.test(l) && l.trim() !== "") break;
      rest.push(l.trim());
    }
    value = rest.filter((l) => l !== "").join(" ");
  } else if (/^(["']).*\1$/.test(value)) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  if (value === "") return null;
  return value.length > DESCRIPTION_CHARS ? `${value.slice(0, DESCRIPTION_CHARS - 1)}…` : value;
}

/** A skill file's front matter description: only its first FRONT_MATTER_BYTES are read. Null when unreadable. */
async function skillDescription(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(FRONT_MATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONT_MATTER_BYTES, 0);
    return frontMatterDescription(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The skills in each folder: a subfolder with a `SKILL.md` (Claude Code's layout), or a top-level `<name>.md` (a
 * pack's `skills/` layout). Names, and the skill file's front matter description only. A folder that is missing or
 * unreadable lists none.
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
        if (inner.includes("SKILL.md")) out.push({ name: e.name, folder, description: await skillDescription(join(folder, e.name, "SKILL.md")) });
      } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") {
        out.push({ name: e.name.slice(0, -".md".length), folder, description: await skillDescription(join(folder, e.name)) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder));
}

/**
 * The imported skills: the newest pointer per source and path, each read from its file now. The file's bytes are
 * hashed: a gone or unreadable file is `missing`, a different SHA-256 is `changed`, and only an `ok` one gives its
 * front matter description. The text is never kept. Its folder is the skills folder that holds its own.
 */
export async function readSkillRefs(refs: readonly SkillRef[]): Promise<Skill[]> {
  const newest = new Map<string, SkillRef>();
  for (const r of refs) {
    const key = `${r.source}\n${r.path}`;
    const seen = newest.get(key);
    if (!seen || r.created_at > seen.created_at) newest.set(key, r);
  }
  const out: Skill[] = [];
  for (const r of newest.values()) {
    const bytes = await readFile(r.path).catch(() => null);
    const state: SkillState = bytes === null ? "missing" : createHash("sha256").update(bytes).digest("hex") === r.sha256 ? "ok" : "changed";
    const description = state === "ok" ? frontMatterDescription(bytes!.subarray(0, FRONT_MATTER_BYTES).toString("utf8")) : null;
    out.push({ name: r.name, folder: dirname(dirname(r.path)), description, imported: { source: r.source, path: r.path, state } });
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
 * The Capabilities list: skills, then tools, then providers. A skill in a configured folder is enabled, and an imported
 * one while its file is unchanged (`ok`); no role grant exists for skills, so it names no role. A tool is enabled when a role is granted it; a tool that is not read-only
 * never reaches an agent. A provider entry is enabled when config selects it, for the roles of its interface.
 */
export function capabilityList(i: CapabilityInputs): Capability[] {
  const used = (id: string) => i.last_used.get(id) ?? null;
  const skills: Capability[] = i.skills.map((s) => ({
    kind: "skill", id: `skill:${s.name}`, name: s.name, detail: s.folder, description: s.description,
    enabled: s.imported === undefined || s.imported.state === "ok", roles: [], last_used: used(`skill:${s.name}`),
    ...(s.imported ? { imported: s.imported } : {}),
  }));
  const tools: Capability[] = i.sources.tools.map((t) => {
    const roles = Object.entries(i.grants).filter(([, names]) => t.read_only && (names ?? []).includes(grantName(t))).map(([kind]) => kind).sort();
    return { kind: "tool", id: toolId(t), name: grantName(t), detail: t.description, enabled: roles.length > 0, roles, last_used: used(toolId(t)), read_only: t.read_only, origin: t.origin };
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
