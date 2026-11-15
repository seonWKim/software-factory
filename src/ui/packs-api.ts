// The Plugins page's pack writes (design 11-packs, issue #589; design 09-dashboard-app, 2026-11-16). POST
// /api/v1/packs/approvals takes one of:
// - `{ "action": "approve" | "revoke", "kind": "tool" | "mcp_server", "name": <name>, "description_hash"?: <prefix> }`:
//   approves or revokes one stored description, through the same path as `factory pack approve|revoke`
//   (changeApproval): `approve_tool` through the page's auth plugin, then one ext_packs_approvals row with the page's
//   factory user ID.
// - `{ "action": "scan" }`: what `factory plugins import --dry-run` finds in the user-level Claude Code and Codex
//   configs (kind, source and name only; never a descriptor). Writes nothing.
// - `{ "action": "import", "items": [{ "kind", "source", "name" }] }`: scans again and stores the picked items as
//   `factory plugins import` does (importFound): an MCP server as a pending pack entry, a skill as a reference. The
//   page's names pick from the server's own scan; a descriptor never comes from the request.
// - `{ "action": "add", "path": <absolute path> }`: `factory pack add` (addPack) for a pack folder, or for one
//   descriptor file in a pack's tools/ or mcp_servers/ folder (that file alone, with its tool module beside it).
// Import and add store what they find as pending: nothing is approved, started or granted. They are one route with
// approve because the server's write routes are one per path. The request guards (Host, Origin, Content-Type, CSRF
// token, body size, JSON) run in server.ts first; every refusal comes before any store write.

import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { importFound, importLine, userConfigHome } from "../import/import-plugins.js";
import { type Found, IMPORT_KINDS, IMPORT_SOURCES, scanUserConfigs } from "../import/scan.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { type ApprovalRequest, PackApprovalsStore, approvalLine, changeApproval } from "../packs/pack-approvals.store.js";
import { PACK_TOOL_MODULE, PackEntriesStore, addLine, addPack } from "../packs/pack-entries.store.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const PACK_APPROVALS_PATH = "/api/v1/packs/approvals";

/** A pack's descriptor folders: a file the Add picks must sit in one of them. */
const DESCRIPTOR_DIRS = ["tools", "mcp_servers"];

const objectOf = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

/** The body as a request, or why it is not one. */
function request(body: unknown): ApprovalRequest | string {
  const b = objectOf(body);
  if (b.action !== "approve" && b.action !== "revoke") return "action must be approve, revoke, scan, import or add";
  if (typeof b.kind !== "string" || typeof b.name !== "string" || b.name === "") return "kind and name must be strings";
  if (b.description_hash !== undefined && (typeof b.description_hash !== "string" || b.description_hash === "")) return "description_hash must be a non-empty string";
  return { action: b.action, kind: b.kind, name: b.name, ...(b.description_hash === undefined ? {} : { hash: b.description_hash }) };
}

/** POST /api/v1/packs/approvals, after the request guards. `p.auth` is set (the route is wired only then). `home`: the user configs' home. */
export async function writePackApproval(d: PauseDeps, p: UiPauses, body: unknown, home: string = userConfigHome()): Promise<ApiResult> {
  const action = objectOf(body).action;
  if (action === "scan") return scan(d, home);
  if (action === "import" || action === "add") {
    const user_id = await p.principal();
    if (user_id === null) return noUser();
    return action === "import" ? importPicked(d, home, user_id, objectOf(body).items) : addPath(d, user_id, objectOf(body).path);
  }
  const r = request(body);
  if (typeof r === "string") return { status: 400, value: { error: r } };
  const user_id = await p.principal();
  if (user_id === null) return noUser();
  const db = storeSql(d.store);
  const now = () => d.clock.now().toISOString();
  const result = await changeApproval({ auth: p.auth!, entries: new PackEntriesStore(db, now), approvals: new PackApprovalsStore(db, now), user_id }, r);
  if (!result.ok) return { status: result.refusal === "not_allowed" ? 403 : 404, value: { error: approvalLine(r, result) } };
  return { status: 200, value: { ...result.ref, action: r.action, line: approvalLine(r, result) } };
}

const noUser = (): ApiResult => ({ status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } });

/** The user configs' skills and MCP servers, every source and kind. */
const scanAll = (home: string) => scanUserConfigs({ home, sources: IMPORT_SOURCES, kinds: IMPORT_KINDS });

/** `{ action: "scan" }`: each found item's kind, source and name, and each source that stopped. */
async function scan(d: PauseDeps, home: string): Promise<ApiResult> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const { found, errors } = await scanAll(home);
  const items = [];
  for (const f of found) items.push({ kind: f.kind, source: f.source, name: await text(f.name) });
  const messages = [];
  for (const e of errors) messages.push(await text(e.message));
  return { status: 200, value: { found: items, errors: messages } };
}

const key = (f: { kind?: unknown; source?: unknown; name?: unknown }) => JSON.stringify([f.kind, f.source, f.name]);

/** `{ action: "import", items }`: the picked items of a fresh scan, stored as `factory plugins import` stores them. */
async function importPicked(d: PauseDeps, home: string, added_by: string, items: unknown): Promise<ApiResult> {
  if (!Array.isArray(items) || items.length === 0 || !items.every((i) => typeof i === "object" && i !== null)) {
    return { status: 400, value: { error: "items must be a non-empty list of { kind, source, name }" } };
  }
  const picked = new Set(items.map((i) => key(i as Record<string, unknown>)));
  const { found } = await scanAll(home);
  const chosen: Found[] = found.filter((f) => picked.has(key(f)));
  const gone = items.length - chosen.length;
  const results = await importFound({ db: storeSql(d.store), now: () => d.clock.now().toISOString(), scanner: d.scanner, added_by, found: chosen });
  const lines = results.map(importLine);
  if (gone > 0) lines.push(`${gone} picked item(s) are no longer in the user configs; nothing stored for them`);
  return lines.length === 0 ? { status: 404, value: { error: "nothing picked is in the user configs" } } : done(d, lines, results.some((r) => r.outcome === "refused"));
}

/** `{ action: "add", path }`: a pack folder, or one descriptor file of a pack, through addPack. */
async function addPath(d: PauseDeps, added_by: string, raw: unknown): Promise<ApiResult> {
  if (typeof raw !== "string" || raw.trim() === "") return { status: 400, value: { error: "path must be a non-empty string" } };
  const path = raw.trim();
  if (!isAbsolute(path)) return { status: 400, value: { error: "path must be absolute" } };
  const kind = await stat(path).then((s) => (s.isDirectory() ? "folder" : s.isFile() ? "file" : null), () => null);
  if (kind === null) return { status: 404, value: { error: `no file or folder at ${path}` } };
  const store = new PackEntriesStore(storeSql(d.store), () => d.clock.now().toISOString());
  const add = (folder: string) => addPack({ path: folder, store, scanner: d.scanner, added_by });
  if (kind === "folder") {
    const results = await add(path);
    if (results.length === 0) return { status: 422, value: { error: `no tools/*.json or mcp_servers/*.json under ${path}` } };
    return done(d, results.map(addLine), results.some((r) => r.outcome === "refused"));
  }
  const dir = basename(dirname(path));
  if (!path.endsWith(".json") || !DESCRIPTOR_DIRS.includes(dir)) {
    return { status: 422, value: { error: "pick a pack folder, or a .json file in a pack's tools/ or mcp_servers/ folder" } };
  }
  // One file: a pack of that file alone (and a tool's module beside it), so no other file of its pack is stored.
  const one = await mkdtemp(join(tmpdir(), "sf-pack-add-"));
  try {
    await mkdir(join(one, dir));
    await copyFile(path, join(one, dir, basename(path)));
    const module = `${path.slice(0, -".json".length)}${PACK_TOOL_MODULE}`;
    if (dir === "tools") await copyFile(module, join(one, dir, basename(module))).catch(() => undefined);
    const results = await add(one);
    return done(d, results.map(addLine), results.some((r) => r.outcome === "refused"));
  } finally {
    await rm(one, { recursive: true, force: true });
  }
}

/** 200 with the CLI's lines, each through the Withholder (they name the owner's paths and names); `refused` when a scan refused an item. */
async function done(d: PauseDeps, lines: readonly string[], refused: boolean): Promise<ApiResult> {
  const w = new Withholder(d.scanner);
  const out = [];
  for (const l of lines) out.push((await w.plain(l)).text);
  return { status: 200, value: { lines: out, refused } };
}
