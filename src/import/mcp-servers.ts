// The MCP server entries of the config files `factory plugins import` reads (design 11-plugin-import): which table
// of a file holds them, and the allow-listed descriptor of one entry. One builder serves the scan, the pointer reader
// (PackEntriesStore.current, when a server is used or shown) and the pointer migration, so the three hash the same
// descriptor. Reads only: nothing here writes.
//
// Env values never leave this file. A descriptor is built from an allow-list of fields (`type`, `command`, `args`,
// `url` without its query, user or fragment) plus `env_keys` and `header_keys`: the names, never the values.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Json } from "../packs/pack-scans.js";
import { parseToml } from "./toml.js";

/** A config that parsed but is not laid out as expected; the message names no value. */
export class NotParsed extends Error {}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function tableAt(doc: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(doc)) throw new NotParsed("is not an object at the top");
  const t = doc[key];
  if (t === undefined) return null;
  if (!isObject(t)) throw new NotParsed(`has a ${key} that is not a table`);
  return t;
}

/**
 * The MCP server table of a config file's text: `[mcp_servers]` of a `.toml` file, else the JSON `mcpServers`; a
 * `.mcp.json` with no `mcpServers` holds its servers at the top level (as some Claude Code plugins write it). Null
 * when the file has none. Throws when the text does not parse (NotParsed, TomlError or a JSON SyntaxError).
 */
export function serverTable(file: string, text: string): Record<string, unknown> | null {
  if (file.endsWith(".toml")) return tableAt(parseToml(text), "mcp_servers");
  const doc = JSON.parse(text) as unknown;
  const table = tableAt(doc, "mcpServers");
  return table === null && basename(file) === ".mcp.json" ? (doc as Record<string, unknown>) : table;
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

/** Where a source label's items come from, in words: `claude`, `codex`, `claude-plugin:<name>`, `project:<repo>`, ... */
export function sourceWords(source: string): string {
  const [group, rest = ""] = source.split(/:(.*)/s, 2) as [string, string?];
  if (group === "claude") return "the Claude Code user config";
  if (group === "codex") return "the Codex user config";
  if (group === "claude-plugin") return `the Claude Code plugin ${rest}`;
  if (group === "claude-command") return "the Claude Code user commands";
  if (group === "claude-desktop") return "the Claude Desktop config";
  if (group === "project") return `the project ${rest}`;
  return `the folder ${rest}`;
}

/** The descriptor of one MCP server: allow-listed fields only, env and headers by key name. What the SHA-256 covers. */
export function serverDescriptor(source: string, key: string, raw: Record<string, unknown>): Record<string, Json> {
  const d: Record<string, Json> = { name: key, description: `Imported from ${sourceWords(source)}`, source };
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

/** The file's text; null when it does not exist. */
export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * The descriptor of the server `key` in `file` now, as the scan would build it; null when the file or the entry is
 * gone, or the file no longer parses. Reads only.
 */
export async function readServerDescriptor(source: string, file: string, key: string): Promise<Record<string, Json> | null> {
  let table: Record<string, unknown> | null;
  try {
    const text = await readText(file);
    table = text === null ? null : serverTable(file, text);
  } catch {
    return null;
  }
  const raw = table && Object.hasOwn(table, key) ? table[key] : undefined;
  return isObject(raw) ? serverDescriptor(source, key, raw) : null;
}
