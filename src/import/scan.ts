// The scanner of `factory plugins import` (design 11-plugin-import). It reads what Claude Code and Codex use, each
// under its own source label:
// - `claude`: `~/.claude.json` `mcpServers` and `~/.claude/skills/<name>/SKILL.md`;
// - `claude-command`: `~/.claude/commands/*.md` (kind `command`);
// - `claude-plugin:<name>`: each plugin `~/.claude/settings.json` `enabledPlugins` turns on, at the install path
//   `~/.claude/plugins/installed_plugins.json` gives it: its `skills/<name>/SKILL.md` and `.mcp.json`. A disabled
//   plugin, or one only in the cache, is not read;
// - `codex`: `~/.codex/config.toml` `[mcp_servers.<name>]` and `~/.codex/skills/<name>/SKILL.md`;
// - `project:<repo>`: each managed repo's `.mcp.json` and `.claude/skills/<name>/SKILL.md`;
// - `claude-desktop`: `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers` (macOS path);
// - `folder:<folder name>` (`--from <path>` only): a folder laid out like a plugin, `skills/<name>/SKILL.md`,
//   `commands/*.md` and `.mcp.json`.
// A missing file or folder means that source holds nothing. Reads only: it writes nothing, and never changes a
// scanned file. A config that does not parse stops its source with an error that names the file and never quotes it.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Json } from "../packs/pack-scans.js";
import { NotParsed, isObject, readText, serverDescriptor, serverTable, sourceWords } from "./mcp-servers.js";
import { TomlError } from "./toml.js";

export type ImportKind = "skill" | "command" | "mcp_server";
export const IMPORT_KINDS: readonly ImportKind[] = ["skill", "command", "mcp_server"];

/** The user-level sources `--source` picks; an item's label starts with its source (`claude-plugin:firebase`). */
export const IMPORT_SOURCES = ["claude", "claude-command", "claude-plugin", "codex", "project", "claude-desktop"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** A skill's SKILL.md or a command's `.md`: stored as a pointer (path and SHA-256), never its text. */
export interface FoundFile {
  readonly kind: "skill" | "command";
  /** The source label. */
  readonly source: string;
  /** A skill's folder name; a command's file name without `.md`. */
  readonly name: string;
  /** The absolute path of the file. */
  readonly path: string;
  /** The SHA-256 of the file's bytes. */
  readonly sha256: string;
}

export interface FoundMcpServer {
  readonly kind: "mcp_server";
  readonly source: string;
  /** The server's key in its file. */
  readonly name: string;
  /** The absolute path of the file that holds it. */
  readonly file: string;
  /** The allow-listed fields and the env and header key names: what is scanned and hashed, never stored. */
  readonly descriptor: { readonly [key: string]: Json };
}

export type Found = FoundFile | FoundMcpServer;

/** A source that stopped: its config file did not parse. Names the file; never quotes it. */
export interface SourceError {
  readonly source: string;
  readonly file: string;
  readonly message: string;
}

export interface ScanResult {
  found: Found[];
  errors: SourceError[];
}

/** One place items come from: a label and the files it may hold. */
interface Place {
  readonly source: string;
  readonly mcp?: string;
  readonly skills?: string;
  readonly commands?: string;
}

/** A managed repo: its name (the `project:<repo>` label) and its checkout. */
export interface ManagedRepo {
  readonly name: string;
  readonly path: string;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The visible entries of a folder; none when it is missing. */
async function entries(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

/** The file's bytes; null when it is gone. */
async function bytesOf(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw err;
  }
}

/** Every `<dir>/<name>/SKILL.md`, by name. */
async function skills(source: string, dir: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const e of await entries(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const path = join(dir, e.name, "SKILL.md");
    const bytes = await bytesOf(path);
    if (bytes !== null) out.push({ kind: "skill", source, name: e.name, path, sha256: sha256(bytes) });
  }
  return out;
}

/** Every `<dir>/<name>.md`, by name. */
async function commands(source: string, dir: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const e of await entries(dir)) {
    if (!e.name.endsWith(".md") || e.isDirectory()) continue;
    const path = join(dir, e.name);
    const bytes = await bytesOf(path);
    if (bytes !== null) out.push({ kind: "command", source, name: e.name.slice(0, -".md".length), path, sha256: sha256(bytes) });
  }
  return out;
}

/** The error of a file that does not parse: names it, never quotes it (JSON.parse's own message can). */
function notParsed(source: string, file: string, err: unknown): SourceError {
  if (!(err instanceof NotParsed || err instanceof TomlError || err instanceof SyntaxError)) throw err;
  const where = err instanceof TomlError ? ` at line ${err.line}` : "";
  const why = err instanceof NotParsed ? err.message : `does not parse${where}`;
  return { source, file, message: `${source}: ${file} ${why}; nothing imported from ${sourceWords(source)}` };
}

/** One place's skills, commands and MCP servers, each by name; an error instead when its MCP file does not parse. */
async function scanPlace(p: Place, kinds: readonly ImportKind[]): Promise<Found[] | SourceError> {
  let servers: Record<string, unknown> | null = null;
  if (p.mcp !== undefined) {
    const text = await readText(p.mcp);
    try {
      servers = text === null ? null : serverTable(p.mcp, text);
    } catch (err) {
      return notParsed(p.source, p.mcp, err);
    }
  }
  const out: Found[] = [];
  if (kinds.includes("skill") && p.skills !== undefined) out.push(...(await skills(p.source, p.skills)));
  if (kinds.includes("command") && p.commands !== undefined) out.push(...(await commands(p.source, p.commands)));
  if (kinds.includes("mcp_server") && servers !== null) {
    for (const name of Object.keys(servers).sort()) {
      const raw = servers[name];
      if (isObject(raw)) out.push({ kind: "mcp_server", source: p.source, name, file: p.mcp!, descriptor: serverDescriptor(p.source, name, raw) });
    }
  }
  return out;
}

async function scanPlaces(places: readonly Place[], kinds: readonly ImportKind[], errors: SourceError[] = []): Promise<ScanResult> {
  const found: Found[] = [];
  for (const p of places) {
    const r = await scanPlace(p, kinds);
    if (Array.isArray(r)) found.push(...r);
    else errors.push(r);
  }
  return { found, errors };
}

/** A JSON file's object; null when the file is missing. Throws when it does not parse or is not an object. */
async function jsonObject(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (text === null) return null;
  const doc = JSON.parse(text) as unknown;
  if (!isObject(doc)) throw new NotParsed("is not an object at the top");
  return doc;
}

/** The install path of an `installed_plugins.json` entry: a record, or (version 2) a list of records. */
function installPath(entry: unknown): string | null {
  for (const e of Array.isArray(entry) ? entry : [entry]) if (isObject(e) && typeof e.installPath === "string") return e.installPath;
  return null;
}

/** Each plugin `enabledPlugins` turns on and `installed_plugins.json` installs, by its ID (`<name>@<marketplace>`). */
async function enabledPlugins(home: string): Promise<Place[] | SourceError> {
  const settings = join(home, ".claude", "settings.json");
  const installed = join(home, ".claude", "plugins", "installed_plugins.json");
  let enabled: Record<string, unknown> | null;
  let plugins: Record<string, unknown> | null;
  try {
    enabled = (await jsonObject(settings))?.enabledPlugins as Record<string, unknown> | null;
  } catch (err) {
    return notParsed("claude-plugin", settings, err);
  }
  try {
    const doc = await jsonObject(installed);
    plugins = doc === null ? null : isObject(doc.plugins) ? doc.plugins : doc;
  } catch (err) {
    return notParsed("claude-plugin", installed, err);
  }
  if (!isObject(enabled) || plugins === null) return [];
  const out: Place[] = [];
  for (const id of Object.keys(enabled).sort()) {
    const path = enabled[id] === true ? installPath(plugins[id]) : null;
    if (path === null) continue;
    out.push({ source: `claude-plugin:${id.split("@")[0]}`, mcp: join(path, ".mcp.json"), skills: join(path, "skills") });
  }
  return out;
}

/**
 * What Claude Code and Codex use under `home` and in each managed repo, for the chosen sources (default: all) and
 * kinds, in source order. Writes nothing.
 */
export async function scanUserConfigs(o: {
  home: string;
  kinds: readonly ImportKind[];
  sources?: readonly ImportSource[];
  repos?: readonly ManagedRepo[];
}): Promise<ScanResult> {
  const on = (s: ImportSource) => (o.sources ?? IMPORT_SOURCES).includes(s);
  const places: Place[] = [];
  const errors: SourceError[] = [];
  if (on("claude")) places.push({ source: "claude", mcp: join(o.home, ".claude.json"), skills: join(o.home, ".claude", "skills") });
  if (on("claude-command")) places.push({ source: "claude-command", commands: join(o.home, ".claude", "commands") });
  if (on("claude-plugin")) {
    const plugins = await enabledPlugins(o.home);
    if (Array.isArray(plugins)) places.push(...plugins);
    else errors.push(plugins);
  }
  if (on("codex")) places.push({ source: "codex", mcp: join(o.home, ".codex", "config.toml"), skills: join(o.home, ".codex", "skills") });
  if (on("project")) {
    for (const r of o.repos ?? []) places.push({ source: `project:${r.name}`, mcp: join(r.path, ".mcp.json"), skills: join(r.path, ".claude", "skills") });
  }
  if (on("claude-desktop")) places.push({ source: "claude-desktop", mcp: join(o.home, "Library", "Application Support", "Claude", "claude_desktop_config.json") });
  return scanPlaces(places, o.kinds, errors);
}

/**
 * `--from <path>`: the folder the user picks, laid out like a plugin (`skills/<name>/SKILL.md`, `commands/*.md`,
 * `.mcp.json`), under the label `folder:<folder name>`. A path that is not a folder is an error. Writes nothing.
 */
export async function scanFolder(path: string, kinds: readonly ImportKind[]): Promise<ScanResult> {
  const dir = resolve(path);
  const source = `folder:${basename(dir)}`;
  const isDir = await stat(dir).then((s) => s.isDirectory(), () => false);
  if (!isDir) return { found: [], errors: [{ source, file: dir, message: `${source}: ${dir} is not a folder; nothing imported` }] };
  return scanPlaces([{ source, mcp: join(dir, ".mcp.json"), skills: join(dir, "skills"), commands: join(dir, "commands") }], kinds);
}
