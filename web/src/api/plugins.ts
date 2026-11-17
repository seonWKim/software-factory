// The Plugins page: GET /api/v1/plugins, POST /api/v1/packs/approvals (postPackApproval: Approve and Revoke;
// postPackAdd: Add) and /api/v1/plugins/import (getPluginsImport, which sends the token too; postPluginsImport: the Import dialog).

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import { API } from "./routes.js";

/**
 * An MCP server's or pack tool's approval status on the Plugins page: `waiting` until approved, `off` once revoked
 * (design 11-packs), `missing` when an imported server's source file no longer holds it (design 11-plugin-import).
 */
export type McpStatus = "approved" | "waiting" | "off" | "missing";

/** `/api/v1/plugins` (design 09-dashboard-app, 2026-11-16): what the agents can use, one list per tab. Names and descriptions only. */
export interface PluginsView {
  as_of: string;
  /** The pack write route's token (approve, revoke, import, add); null when this server cannot write packs from the page. */
  csrf_token: string | null;
  mcp: { name: string; description: string | null; source: "pack"; status: McpStatus }[];
  /**
   * The skill folders' skills, and the imported ones (design 11-plugin-import): an imported row adds its `source`, its
   * SKILL.md `path` and its `state` (`missing` or `changed`: not offered to agents). A folder skill's row has none.
   */
  skills: {
    name: string; folder: string; description: string | null; roles: string[]; last_used: string | null;
    source?: "claude" | "codex"; path?: string; state?: "ok" | "missing" | "changed";
  }[];
  tools: { name: string; description: string; read_only: boolean; origin: "broker" | "pack"; roles: string[]; last_used: string | null }[];
  /** Each pack tool's status, by its row name (`pack:tool:<name>`). Absent from an older server. */
  tool_status?: Record<string, McpStatus>;
  /** The configured skill folders as the config file holds them; [] when none. Absent from an older server. */
  skill_folders?: string[];
  /** The Settings route's token the skill folder edits are sent with; null when this server has no config file writer. */
  settings_token?: string | null;
}

/** One skill or MCP server the user-level Claude Code or Codex config holds (design 11-plugin-import). Never a value. */
export interface ImportItem {
  kind: "skill" | "mcp_server";
  source: "claude" | "codex";
  name: string;
  /** A skill's SKILL.md path; null for an MCP server. */
  path: string | null;
  env_keys: string[];
  header_keys: string[];
  /** Already stored: a second import adds nothing. */
  imported: boolean;
  /** The scan rules an MCP server fails; it cannot be imported while non-empty. */
  refused: string[];
}

/** `/api/v1/plugins/import`: what the user configs hold, and each source whose config did not parse. */
export interface PluginsImportView {
  as_of: string;
  items: ImportItem[];
  errors: { source: string; message: string }[];
}

/** One selected item's outcome: stored, already added, refused (with its rules) or not found. */
export interface ImportResult {
  kind: ImportItem["kind"];
  source: ImportItem["source"];
  name: string;
  outcome: "stored" | "already_added" | "refused" | "not_found";
  rules: string[];
  line: string;
}

/** The answer to an Add: the CLI's lines, `refused` when a scan refused an item. */
export type PackWriteResult = { ok: true; lines: string[]; refused: boolean } | { ok: false; error: string };

/** POST /api/v1/packs/approvals: approve or revoke an MCP server's or pack tool's current description, as `factory pack approve|revoke`. */
export async function postPackApproval(token: string, action: "approve" | "revoke", name: string, kind: "mcp_server" | "tool" = "mcp_server"): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const r = await postJson<{ line?: string; error?: string }>(API.packApprovals, token, { action, kind, name });
  if (r.ok) return { ok: true, line: r.value.line ?? "" };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/packs/approvals `add`: a pack folder or one descriptor file, stored as pending. */
export async function postPackAdd(token: string, path: string): Promise<PackWriteResult> {
  const r = await postJson<{ lines?: string[]; refused?: boolean; error?: string }>(API.packApprovals, token, { action: "add", path });
  if (r.ok) return { ok: true, lines: r.value.lines ?? [], refused: r.value.refused === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** GET /api/v1/plugins/import with the CSRF token (it reads the user's own configs): read once per dialog, never polled. */
export async function getPluginsImport(token: string): Promise<PluginsImportView> {
  const res = await fetch(API.pluginsImport, { headers: { accept: "application/json", "x-csrf-token": token } });
  if (!res.ok) throw new Error(`${API.pluginsImport}: HTTP ${res.status}`);
  return (await res.json()) as PluginsImportView;
}

/** POST /api/v1/plugins/import: stores the selected items, as `factory plugins import`. A refusal (400, 403) is `{ ok: false, error }`. */
export async function postPluginsImport(
  token: string,
  items: readonly Pick<ImportItem, "kind" | "source" | "name">[],
): Promise<{ ok: true; results: ImportResult[] } | { ok: false; error: string }> {
  const r = await postJson<{ results?: ImportResult[]; error?: string }>(API.pluginsImport, token, { items: items.map(({ kind, source, name }) => ({ kind, source, name })) });
  if (r.ok) return { ok: true, results: r.value.results ?? [] };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
