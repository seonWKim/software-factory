// The Plugins page's read (design 09-dashboard-app and 11-packs, 2026-11-15): GET /api/v1/plugins lists what the
// agents can use in three lists, one per tab: the MCP servers that packs carry (`ext_packs_entries`, kind
// `mcp_server`), the skills of the configured skill folders and the tools (the broker's and the packs'). "Plugins"
// here means agent capabilities, never the factory's implementation plugins (docs/plugins.md).
//
// One builder (pluginRows) serves the page and `factory plugins list`, so both show the same rows. Names and
// descriptions only: an MCP server's row is its name, its descriptor's `description`, its source and its approval
// status; its descriptor body (command, args, env) never leaves the store read. A skill's description is its file's
// front matter `description`, never its body. Every string leaves through the Withholder. Reading writes nothing.
// Approve and Revoke go through POST /api/v1/packs/approvals (packs-api.ts), the same path as `factory pack approve|revoke`.
// The tools of an approved imported MCP server (design 11-plugin-import, phase 3) are read from `ext_mcp_tool_lists`:
// GET /api/v1/plugins asks for a listing when the server's current description has none (a store row, as the page's
// factory user); a worker starts the server and stores the names. This process never starts a server.

import type { SettingsBase } from "../core/settings.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { McpToolListsStore, approvedImportedServers, requestMcpToolLists } from "../import/mcp-tool-lists.js";
import { type CapabilityDeps, type UiCapabilitySources, capabilityRows, settingsSources } from "./capabilities-api.js";
import type { ApiDeps, ApiResult } from "./api.js";
import { Withholder } from "./withhold.js";

export const PLUGINS_PATH = "/api/v1/plugins";

/** The page's tabs and the CLI's `--kind` values, in tab order. */
export const PLUGIN_KINDS = ["mcp", "skill", "tool"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * An MCP server's status: `approved` (its current description's latest approval row is an approve), `off` (that
 * row is a revoke: the owner turned it off), `waiting` (no row for this description: never approved, or changed
 * since its approval, so the pin asks again).
 */
export type McpStatus = "approved" | "waiting" | "off";

export interface McpRow {
  name: string;
  /** The descriptor's `description`; null when it has none. */
  description: string | null;
  /** Where it comes from: a pack (`factory pack add`). Imported config is not read (decision 2). */
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

/** The descriptor's `description` string; nothing else of the body is kept. */
function descriptionOf(descriptor: unknown): string | null {
  try {
    const d = JSON.parse(String(descriptor)) as unknown;
    return typeof d === "object" && d !== null && typeof (d as { description?: unknown }).description === "string" ? (d as { description: string }).description : null;
  } catch {
    return null;
  }
}

/** Each stored MCP server's current description (the one added last) and its status, by name. */
async function mcpRows(d: Pick<CapabilityDeps, "store">): Promise<McpRow[]> {
  const db = storeSql(d.store);
  const entries = await db.all("SELECT name, description_hash, descriptor FROM ext_packs_entries WHERE kind = 'mcp_server' ORDER BY name, created_at DESC, id DESC");
  const approvals = await db.all("SELECT name, description_hash, action FROM ext_packs_approvals WHERE kind = 'mcp_server' ORDER BY seq");
  const latest = new Map(approvals.map((a) => [`${String(a.name)}\n${String(a.description_hash)}`, String(a.action)]));
  const out: McpRow[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const name = String(e.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const action = latest.get(`${name}\n${String(e.description_hash)}`);
    out.push({ name, description: descriptionOf(e.descriptor), source: "pack", status: action === "approve" ? "approved" : action === "revoke" ? "off" : "waiting" });
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
  for (const m of await mcpRows(d)) mcp.push({ ...m, name: await text(m.name), description: m.description === null ? null : await text(m.description) });
  const mcpTools: ToolRow[] = [];
  for (const r of await mcpToolRows(d)) mcpTools.push({ ...r, name: await text(r.name), description: await text(r.description) });
  return {
    mcp,
    skills: caps.filter((c) => c.kind === "skill").map((c) => ({ name: c.name, folder: c.detail ?? "", description: c.description ?? null, roles: c.roles, last_used: c.last_used })),
    tools: caps
      .filter((c) => c.kind === "tool")
      .map((c): ToolRow => ({ name: c.name, description: c.detail ?? "", read_only: c.read_only === true, origin: c.origin ?? "broker", roles: c.roles, last_used: c.last_used }))
      .concat(mcpTools),
  };
}

/**
 * GET /api/v1/plugins: the three lists, and the token of the approvals route (null when the page cannot approve).
 * With a factory user it first asks for the tool listing of each approved imported MCP server that has none (a
 * request row only: the worker starts the server); with none, nothing is asked.
 */
export async function readPlugins(d: ApiDeps): Promise<ApiResult> {
  if (!d.settings) return { status: 404, value: { error: "Not found." } };
  const user = d.pauses ? await d.pauses.principal() : null;
  if (user !== null) await requestMcpToolLists(storeSql(d.store), () => d.clock.now().toISOString(), user);
  const rows = await pluginRows(d, d.settings.base, await settingsSources(d.settings));
  return { status: 200, value: { as_of: d.clock.now().toISOString(), csrf_token: d.pauses?.auth !== undefined ? d.pauses.csrfToken : null, ...rows } };
}

const roles = (r: readonly string[]) => (r.length > 0 ? r.join(",") : "-");
const or = (v: string | null) => (v === null || v === "" ? "-" : v);

/** `factory plugins list`'s lines for one kind: one row per line, the page's columns separated by two spaces. */
export function pluginLines(rows: PluginRows, kind: PluginKind): string[] {
  if (kind === "mcp") return rows.mcp.map((m) => [m.name, m.status, m.source, or(m.description)].join("  "));
  if (kind === "skill") return rows.skills.map((s) => [s.name, s.folder, or(s.description), roles(s.roles), or(s.last_used)].join("  "));
  return rows.tools.map((t) => [t.name, t.origin, t.read_only ? "read-only" : "writes", roles(t.roles), or(t.last_used), or(t.description)].join("  "));
}
