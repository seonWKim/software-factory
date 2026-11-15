// The user-config scanner of `factory plugins import` (design 11-plugin-import): reads the user-level Claude Code
// config (`~/.claude.json` `mcpServers`, `~/.claude/skills/<name>/SKILL.md`) and Codex config
// (`~/.codex/config.toml` `[mcp_servers.<name>]`, `~/.codex/skills/<name>/SKILL.md`). Reads only: it writes nothing.
//
// Env values never leave this file. An MCP server becomes a descriptor built from an allow-list of fields (`type`,
// `command`, `args`, `url` without its query, user or fragment) plus `env_keys` and `header_keys`: the names, never
// the values. A config that does not parse stops its source with an error that names the file and never quotes it.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "../packs/pack-scans.js";
import { TomlError, parseToml } from "./toml.js";

export type ImportSource = "claude" | "codex";
export type ImportKind = "skill" | "mcp_server";

export const IMPORT_SOURCES: readonly ImportSource[] = ["claude", "codex"];
export const IMPORT_KINDS: readonly ImportKind[] = ["skill", "mcp_server"];

export interface FoundSkill {
  readonly kind: "skill";
  readonly source: ImportSource;
  /** The skill's folder name. */
  readonly name: string;
  /** The absolute path of its SKILL.md. */
  readonly path: string;
  /** The SHA-256 of the file's bytes; its text is never kept. */
  readonly sha256: string;
}

export interface FoundMcpServer {
  readonly kind: "mcp_server";
  readonly source: ImportSource;
  readonly name: string;
  /** The allow-listed fields and the env and header key names: no env or header value. */
  readonly descriptor: { readonly [key: string]: Json };
}

export type Found = FoundSkill | FoundMcpServer;

/** A source that stopped: its config file did not parse. Names the file; never quotes it. */
export interface SourceError {
  readonly source: ImportSource;
  readonly file: string;
  readonly message: string;
}

interface SourceLayout {
  readonly label: string;
  readonly config: (home: string) => string;
  readonly skills: (home: string) => string;
  /** The user-level MCP server table of the parsed config; null when the config has none. */
  readonly servers: (text: string) => Record<string, unknown> | null;
}

const LAYOUTS: Readonly<Record<ImportSource, SourceLayout>> = {
  claude: {
    label: "Claude Code",
    config: (home) => join(home, ".claude.json"),
    skills: (home) => join(home, ".claude", "skills"),
    servers: (text) => tableAt(JSON.parse(text) as unknown, "mcpServers"),
  },
  codex: {
    label: "Codex",
    config: (home) => join(home, ".codex", "config.toml"),
    skills: (home) => join(home, ".codex", "skills"),
    servers: (text) => tableAt(parseToml(text), "mcp_servers"),
  },
};

/** The label a line shows for a source. */
export const sourceLabel = (s: ImportSource): string => LAYOUTS[s].label;

class NotParsed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function tableAt(doc: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(doc)) throw new NotParsed("is not an object at the top");
  const t = doc[key];
  if (t === undefined) return null;
  if (!isObject(t)) throw new NotParsed(`has a ${key} that is not a table`);
  return t;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The names of an object's keys (or of a list's strings) that look like variable or header names; sorted. */
function names(...from: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of from) {
    const list = isObject(v) ? Object.keys(v) : Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const n of list) if (typeof n === "string" && ENV_NAME.test(n.replace(/-/g, "_"))) out.add(n);
  }
  return [...out].sort();
}

/** A URL without its user, password, query or fragment (any of which can carry a credential); null when invalid. */
function bareUrl(text: string): string | null {
  try {
    const u = new URL(text);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/** The stored descriptor of one MCP server: allow-listed fields only, env and headers by key name. */
function serverDescriptor(source: ImportSource, name: string, raw: Record<string, unknown>): Record<string, Json> {
  const d: Record<string, Json> = { name, description: `Imported from the ${sourceLabel(source)} user config`, source };
  if (typeof raw.type === "string") d.type = raw.type;
  if (typeof raw.command === "string") d.command = raw.command;
  if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")) d.args = raw.args as string[];
  const url = typeof raw.url === "string" ? bareUrl(raw.url) : null;
  if (url !== null) d.url = url;
  // Claude: env. Codex: env, env_vars (names it forwards) and bearer_token_env_var (a name).
  d.env_keys = names(raw.env, raw.env_vars, raw.bearer_token_env_var);
  const headers = names(raw.headers, raw.http_headers, raw.env_http_headers);
  if (headers.length > 0) d.header_keys = headers;
  return d;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Every `<dir>/<name>/SKILL.md`, by name; none when the folder is missing. */
async function skills(source: ImportSource, dir: string): Promise<FoundSkill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: FoundSkill[] = [];
  for (const name of entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).map((e) => e.name).sort()) {
    const path = join(dir, name, "SKILL.md");
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    out.push({ kind: "skill", source, name, path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return out;
}

/** One source's skills then MCP servers, each by name; an error instead when its config does not parse. */
async function scanSource(home: string, source: ImportSource, kinds: readonly ImportKind[]): Promise<Found[] | SourceError> {
  const layout = LAYOUTS[source];
  const file = layout.config(home);
  const text = await readText(file);
  let servers: Record<string, unknown> | null = null;
  try {
    servers = text === null ? null : layout.servers(text);
  } catch (err) {
    // JSON.parse's own message can quote the text; the TOML reader's names the line only.
    const where = err instanceof TomlError ? ` at line ${err.line}` : "";
    const why = err instanceof NotParsed ? err.message : `does not parse${where}`;
    return { source, file, message: `${source}: ${file} ${why}; nothing imported from ${sourceLabel(source)}` };
  }
  const out: Found[] = kinds.includes("skill") ? await skills(source, layout.skills(home)) : [];
  if (kinds.includes("mcp_server") && servers !== null) {
    for (const name of Object.keys(servers).sort()) {
      const raw = servers[name];
      if (isObject(raw)) out.push({ kind: "mcp_server", source, name, descriptor: serverDescriptor(source, name, raw) });
    }
  }
  return out;
}

/** What the user configs under `home` hold, for the chosen sources and kinds, in source order. Writes nothing. */
export async function scanUserConfigs(o: {
  home: string;
  sources: readonly ImportSource[];
  kinds: readonly ImportKind[];
}): Promise<{ found: Found[]; errors: SourceError[] }> {
  const found: Found[] = [];
  const errors: SourceError[] = [];
  for (const source of IMPORT_SOURCES.filter((s) => o.sources.includes(s))) {
    const r = await scanSource(o.home, source, o.kinds);
    if (Array.isArray(r)) found.push(...r);
    else errors.push(r);
  }
  return { found, errors };
}
