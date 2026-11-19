// The Plugins page's read (design 09-dashboard-app and 11-packs, 2026-11-15): GET /api/v1/plugins lists what the
// agents can use in three lists, one per tab: the MCP servers that packs carry (`ext_packs_entries`, kind
// `mcp_server`), the skills of the configured skill folders and the tools (the broker's and the packs'). "Plugins"
// here means agent capabilities, never the factory's implementation plugins (docs/plugins.md).
//
// One builder (pluginRows) serves the page and `factory plugins list`, so both show the same rows. Names and
// descriptions only: an MCP server's row is its name, its descriptor's `description`, its source and its approval
// status; its descriptor body (command, args, env) never leaves the read. An imported MCP server is a pointer row
// (design 11-plugin-import): its descriptor is read from its source file now, and it is `missing` when the file no
// longer holds it. The Skills tab lists the imported skills of the sources the page has labels for (claude, codex);
// the CLI lists the others. A skill's description is its file's
// front matter `description`, never its body. An imported skill (design 11-plugin-import, an `ext_skill_refs` pointer
// read from its SKILL.md now) adds its source, path and state (`ok`, `missing`, `changed`) to its row; a folder skill's
// row has none of them. Every string leaves through the Withholder. Reading writes nothing.
// Approve and Revoke go through POST /api/v1/packs/approvals (packs-api.ts), the same path as `factory pack approve|revoke`,
// for an MCP server and for a pack tool: the page's read adds each pack tool's status (`tool_status`), the configured
// skill folders as the file holds them (`skill_folders`, [] when none) and the Settings route's token the skill folder
// edits are sent with (`settings_token`, null without the config file's writer). `factory plugins list` prints none of these.
// The tools of an approved imported MCP server (design 11-plugin-import, phase 3) are read from `ext_mcp_tool_lists`:
// GET /api/v1/plugins asks for a listing when the server's current description has none (a store row, as the page's
// factory user); a worker starts the server and stores the names. This process never starts a server.

import type { SettingsBase } from "../core/settings.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { McpToolListsStore, approvedImportedServers, requestMcpToolLists } from "../import/mcp-tool-lists.js";
import { PackEntriesStore } from "../packs/pack-entries.store.js";
import type { SkillRefSource, SkillState } from "../runtime/capabilities/capabilities.js";
import { type Activity, BackgroundSnapshot } from "./background-refresh.js";
import { HEALTH_MIN_INTERVAL_MS } from "./health.js";
import { type CapabilityDeps, type UiCapabilitySources, capabilityRows, settingsSources } from "./capabilities-api.js";
import type { ApiDeps, ApiResult } from "./api.js";
import type { UiSettings } from "./settings-api.js";
import { Withholder } from "./withhold.js";

export const PLUGINS_PATH = "/api/v1/plugins";
/** The config file key the Plugins page's skill folder edits write (core/config-writer.ts FILE_ONLY_KEYS). */
export const SKILL_FOLDERS_KEY = "capabilities.skill_folders";

/** The page's tabs and the CLI's `--kind` values, in tab order. */
export const PLUGIN_KINDS = ["mcp", "skill", "tool"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * An MCP server's status: `approved` (its current description's latest approval row is an approve), `off` (that
 * row is a revoke: the owner turned it off), `waiting` (no row for this description: never approved, or changed
 * since its approval, so the pin asks again; an imported server whose file entry changed since import too),
 * `missing` (an imported server whose source file no longer holds it: nothing runs it).
 */
export type McpStatus = "approved" | "waiting" | "off" | "missing";

export interface McpRow {
  name: string;
  /** The descriptor's `description`; null when it has none. */
  description: string | null;
  /** Where it comes from: a pack, added or imported. */
  source: "pack";
  status: McpStatus;
}

export interface SkillRow {
  name: string;
  folder: string;
  /** The skill file's front matter `description`; null when it has none. */
  description: string | null;
  roles: string[];
  last_used: string | null;
  /** An imported skill: where it was found (absent: a skill folder's). */
  source?: SkillRefSource;
  /** An imported skill: its SKILL.md path. */
  path?: string;
  /** An imported skill: `ok`, or `missing` or `changed` (not offered to agents). */
  state?: SkillState;
}

export interface ToolRow {
  /** The name `tool_grants` gives it (`pack:tool:<name>` for a pack's); `mcp:<server>:<tool>` or `mcp:<server>` for an imported MCP server's. */
  name: string;
  description: string;
  read_only: boolean;
  origin: "broker" | "pack" | "mcp";
  roles: string[];
  last_used: string | null;
}

export interface PluginRows {
  mcp: McpRow[];
  skills: SkillRow[];
  tools: ToolRow[];
}

/** Each stored entry of `kind`: its current description (the one added last, an imported server's read from its file) and its status, by name. */
async function entryRows(d: Pick<CapabilityDeps, "store">, kind: "mcp_server" | "tool"): Promise<McpRow[]> {
  const db = storeSql(d.store);
  const entries = new PackEntriesStore(db, () => "");
  const approvals = await db.all("SELECT name, description_hash, action FROM ext_packs_approvals WHERE kind = ? ORDER BY seq", [kind]);
  const latest = new Map(approvals.map((a) => [`${String(a.name)}\n${String(a.description_hash)}`, String(a.action)]));
  const out: McpRow[] = [];
  for (const name of await entries.names(kind)) {
    const e = (await entries.current(kind, name))!;
    const action = e.imported?.state === "ok" || e.imported === null ? latest.get(`${name}\n${e.description_hash}`) : undefined;
    const status: McpStatus = e.imported?.state === "missing" ? "missing" : action === "approve" ? "approved" : action === "revoke" ? "off" : "waiting";
    out.push({ name, description: typeof e.descriptor.description === "string" ? e.descriptor.description : null, source: "pack", status });
  }
  return out;
}

/** What an imported server's row says while it has no tool names: listing, not stdio, or did not start (no error text). */
const MCP_LIST_NOTE = {
  requested: "listing its tools",
  running: "listing its tools",
  not_approved: "listing its tools",
  not_stdio: "not a stdio server: its tools are not listed",
  did_not_start: "did not start",
} as const;

/**
 * The Tools tab's rows of each approved imported MCP server, from its current description's stored listing: one per
 * tool name, or one for the server saying why there is none. Reads only. Not read-only: never granted to a run.
 */
async function mcpToolRows(d: Pick<CapabilityDeps, "store">): Promise<ToolRow[]> {
  const db = storeSql(d.store);
  const lists = new Map((await new McpToolListsStore(db, () => "").all()).map((l) => [`${l.name}\n${l.description_hash}`, l]));
  const out: ToolRow[] = [];
  const row = (name: string, description: string): ToolRow => ({ name, description, read_only: false, origin: "mcp", roles: [], last_used: null });
  for (const server of await approvedImportedServers(db)) {
    const list = lists.get(`${server.name}\n${server.description_hash}`);
    if (list?.status === "listed") out.push(...list.tools.map((tool) => row(`mcp:${server.name}:${tool}`, `From MCP server ${server.name}`)));
    else out.push(row(`mcp:${server.name}`, `MCP server ${server.name}: ${MCP_LIST_NOTE[list?.status ?? "requested"]}`));
  }
  return out;
}

/** The three lists: MCP servers, skills and tools, every string through the Withholder. */
export async function pluginRows(d: CapabilityDeps, base: SettingsBase, sources: UiCapabilitySources): Promise<PluginRows> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const caps = await capabilityRows(d, base, sources);
  const mcp: McpRow[] = [];
  for (const m of await entryRows(d, "mcp_server")) mcp.push({ ...m, name: await text(m.name), description: m.description === null ? null : await text(m.description) });
  const mcpTools: ToolRow[] = [];
  for (const r of await mcpToolRows(d)) mcpTools.push({ ...r, name: await text(r.name), description: await text(r.description) });
  return {
    mcp,
    skills: caps.filter((c) => c.kind === "skill").map((c): SkillRow => ({
      name: c.name, folder: c.detail ?? "", description: c.description ?? null, roles: c.roles, last_used: c.last_used,
      ...(c.imported ? { source: c.imported.source, path: c.imported.path, state: c.imported.state } : {}),
    })),
    tools: caps
      .filter((c) => c.kind === "tool")
      .map((c): ToolRow => ({ name: c.name, description: c.detail ?? "", read_only: c.read_only === true, origin: c.origin ?? "broker", roles: c.roles, last_used: c.last_used }))
      .concat(mcpTools),
  };
}

/** The configured skill folders as the file holds them, each through the Withholder; [] when none is configured. */
async function skillFolders(s: UiSettings, w: Withholder): Promise<string[]> {
  const raw = s.editFile?.fileKeys?.().editable.find((k) => k.key === SKILL_FOLDERS_KEY)?.value ?? null;
  const list = raw === null ? [] : (JSON.parse(raw) as unknown);
  const out: string[] = [];
  for (const f of Array.isArray(list) ? list : []) if (typeof f === "string") out.push((await w.plain(f)).text);
  return out;
}

/**
 * GET /api/v1/plugins: the three lists; the token of the pack write route (null when the page cannot approve, import
 * or add); each pack tool's status by its row name; the configured skill folders; and the Settings route's token for
 * the skill folder edits (null when this process has no config file writer). With a factory user it first asks for
 * the tool listing of each approved imported MCP server that has none (a request row only: the worker starts the
 * server); with none, nothing is asked.
 */
export async function readPlugins(d: ApiDeps): Promise<ApiResult> {
  if (!d.settings) return { status: 404, value: { error: "Not found." } };
  const snap = snapshots.get(d);
  const { value, as_of } = snap ? await snap.read() : { value: await discover(d, d.settings), as_of: d.clock.now() };
  const writer = d.settings.editFile?.fileKeys !== undefined;
  return {
    status: 200,
    value: {
      as_of: as_of.toISOString(),
      // The tokens belong to this request, never to the snapshot.
      csrf_token: d.pauses?.auth !== undefined ? d.pauses.csrfToken : null,
      ...value,
      settings_token: writer ? d.settings.csrfToken : null,
    },
  };
}

/** The slow part of the read, everything but the tokens: the three lists, each pack tool's status and the skill folders. */
async function discover(d: ApiDeps, settings: UiSettings) {
  const user = d.pauses ? await d.pauses.principal() : null;
  if (user !== null) await requestMcpToolLists(storeSql(d.store), () => d.clock.now().toISOString(), user);
  const rows = await pluginRows(d, settings.base, await settingsSources(settings));
  const stored = new Map((await entryRows(d, "tool")).map((t) => [`pack:tool:${t.name}`, t.status]));
  const tool_status: Record<string, McpStatus> = {};
  for (const t of rows.tools) if (t.origin === "pack") tool_status[t.name] = stored.get(t.name) ?? "waiting";
  return {
    ...rows,
    skills: rows.skills.filter((r) => r.source === undefined || PAGE_SKILL_SOURCES.includes(r.source)),
    tool_status,
    skill_folders: await skillFolders(settings, new Withholder(d.scanner)),
  };
}

/** The snapshots the UI server installed, by the deps object its routes read with. None: the read is live. */
const snapshots = new WeakMap<ApiDeps, BackgroundSnapshot<Awaited<ReturnType<typeof discover>>>>();

/**
 * Installs the background snapshot of the Plugins read for `d` (design 09-dashboard-settings, 2026-11-19): the same
 * builder (`pluginRows`) runs on an interval while the page is in use and on `refresh()`, and GET /api/v1/plugins
 * answers from its last result. `activity` is shared with the Health snapshot, so a read of either route keeps both
 * refreshing. Returns the handle the server uses after a write and on close. A server without settings has no
 * Plugins route, so nothing is installed.
 */
export function startPluginsSnapshot(d: ApiDeps, activity?: Activity): { refresh(): void; stop(): void } {
  const settings = d.settings;
  if (!settings) return { refresh: () => undefined, stop: () => undefined };
  const snap = new BackgroundSnapshot(() => discover(d, settings), d.clock, HEALTH_MIN_INTERVAL_MS, activity);
  snapshots.set(d, snap);
  snap.start();
  return {
    refresh: () => snap.refreshInBackground(),
    stop: () => {
      snap.stop();
      snapshots.delete(d);
    },
  };
}

/** The imported skills' sources the page has a label for; `factory plugins list` lists the others too. */
const PAGE_SKILL_SOURCES: readonly string[] = ["claude", "codex"];

const roles = (r: readonly string[]) => (r.length > 0 ? r.join(",") : "-");
const or = (v: string | null) => (v === null || v === "" ? "-" : v);

/** `factory plugins list`'s lines for one kind: one row per line, the page's columns separated by two spaces. */
export function pluginLines(rows: PluginRows, kind: PluginKind): string[] {
  if (kind === "mcp") return rows.mcp.map((m) => [m.name, m.status, m.source, or(m.description)].join("  "));
  if (kind === "skill") return rows.skills.map((s) => [s.name, s.folder, or(s.description), roles(s.roles), or(s.last_used)].join("  "));
  return rows.tools.map((t) => [t.name, t.origin, t.read_only ? "read-only" : "writes", roles(t.roles), or(t.last_used), or(t.description)].join("  "));
}
