// The Plugins page's import (design 11-plugin-import, 2026-11-15, phase 2): GET /api/v1/plugins/import lists the
// skills and MCP servers the user-level Claude Code and Codex configs hold (scanUserConfigs, the scan of `factory
// plugins import`), each with whether it is already stored, and writes nothing. POST /api/v1/plugins/import with
// `{ "items": [{ "kind", "source", "name" }] }` scans again and stores the selected items through the same stores and
// rules as the CLI: a skill as an `ext_skill_refs` row, an MCP server, after the three `pack add` scans, as a pending
// `ext_packs_entries` row. The browser names items only; their descriptors come from the server's own scan, so no
// descriptor, env value or header value is ever sent or returned. added_by is the page's factory user (403 when there
// is none). Nothing is started, approved or granted. Each result's `line` is plain words without the CLI's sha256
// (design 11-plugin-import, 2026-11-16): "stored skill deploy from codex". server.ts runs the request guards first: Host and the CSRF token
// for the read; Host, Origin, Content-Type, CSRF token, body size and JSON for the write.

import { storeSql } from "../impl/store/sql/store-sql.js";
import { type ImportOutcome, SkillRefsStore, importLine } from "../import/import-plugins.js";
import { type Found, IMPORT_KINDS, IMPORT_SOURCES, type ImportKind, type ImportSource, scanUserConfigs } from "../import/scan.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../packs/pack-entries.store.js";
import { scanDescriptor } from "../packs/pack-scans.js";
import { skillFolderPath } from "../runtime/capabilities/capabilities.js";
import type { SqlDriver } from "../state/index.js";
import type { ApiDeps, ApiResult } from "./api.js";
import type { UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const PLUGINS_IMPORT_PATH = "/api/v1/plugins/import";

/** The most items one POST may name. */
const MAX_ITEMS = 500;

/** What the browser names an item by: its kind, its source and its name (a skill's folder name). */
interface ItemKey {
  kind: ImportKind;
  source: ImportSource;
  name: string;
}

const keyOf = (i: ItemKey): string => `${i.kind}\n${i.source}\n${i.name}`;

/**
 * Everything both user configs hold, under the owner's home folder: `~` as the Plugins page's skill folders resolve
 * it (skillFolderPath), so the UI layer holds no OS call of its own. Reads only.
 */
const scanAll = () => scanUserConfigs({ home: skillFolderPath("~", "/"), sources: IMPORT_SOURCES, kinds: IMPORT_KINDS });

/** True when this exact item (a skill's path and SHA-256, an MCP server's descriptor) is already stored. */
async function stored(db: SqlDriver, item: Found): Promise<boolean> {
  const rows =
    item.kind === "skill"
      ? await db.all("SELECT 1 AS hit FROM ext_skill_refs WHERE source = ? AND path = ? AND sha256 = ?", [item.source, item.path, item.sha256])
      : await db.all("SELECT 1 AS hit FROM ext_packs_entries WHERE kind = 'mcp_server' AND name = ? AND description_hash = ?", [item.name, descriptionHash(item.descriptor)]);
  return rows.length > 0;
}

/** The key names an MCP server's descriptor carries (never their values). */
const keyNames = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** GET /api/v1/plugins/import, after the Host and CSRF checks: each found item with `imported`, and each source error. */
export async function readPluginsImport(d: ApiDeps): Promise<ApiResult> {
  const db = storeSql(d.store);
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const { found, errors } = await scanAll();
  const items = [];
  for (const item of found) {
    const mcp = item.kind === "mcp_server";
    items.push({
      kind: item.kind,
      source: item.source,
      name: await text(item.name),
      path: mcp ? null : await text(item.path),
      env_keys: mcp ? keyNames(item.descriptor.env_keys) : [],
      header_keys: mcp ? keyNames(item.descriptor.header_keys) : [],
      imported: await stored(db, item),
      // The scans a POST would run: an item that fails one cannot be imported.
      refused: mcp ? await scanDescriptor(d.scanner, item.descriptor, canonicalJson(item.descriptor)) : [],
    });
  }
  return { status: 200, value: { as_of: d.clock.now().toISOString(), items, errors: await Promise.all(errors.map(async (e) => ({ source: e.source, message: await text(e.message) }))) } };
}

/** The body's item keys, or why it is not a list of them. */
function selection(body: unknown): ItemKey[] | string {
  const items = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return `items must be a list of 1 to ${MAX_ITEMS} items`;
  const out: ItemKey[] = [];
  for (const i of items) {
    const o = typeof i === "object" && i !== null ? (i as Record<string, unknown>) : {};
    if (!(IMPORT_KINDS as readonly unknown[]).includes(o.kind)) return `each item's kind must be ${IMPORT_KINDS.join(" or ")}`;
    if (!(IMPORT_SOURCES as readonly unknown[]).includes(o.source)) return `each item's source must be ${IMPORT_SOURCES.join(" or ")}`;
    if (typeof o.name !== "string" || o.name === "") return "each item's name must be a non-empty string";
    out.push({ kind: o.kind as ImportKind, source: o.source as ImportSource, name: o.name });
  }
  return out;
}

/** Stores one found item as the CLI does; an MCP server that fails a scan is refused and not stored. */
async function importOne(o: { db: SqlDriver; now: () => string; d: ApiDeps; added_by: string }, item: Found): Promise<ImportOutcome> {
  if (item.kind === "skill") return { outcome: (await new SkillRefsStore(o.db, o.now).insert(item, o.added_by)) ? "stored" : "already_added", item };
  const canonical = canonicalJson(item.descriptor);
  const rules = await scanDescriptor(o.d.scanner, item.descriptor, canonical);
  if (rules.length > 0) return { outcome: "refused", item, rules };
  const inserted = await new PackEntriesStore(o.db, o.now).insert({
    kind: "mcp_server", name: item.name, description_hash: descriptionHash(item.descriptor), module_hash: null, descriptor: canonical, credential_name: null, added_by: o.added_by,
  });
  return { outcome: inserted ? "stored" : "already_added", item };
}

/** An item's line for the page: importLine without the stored skill's sha256. */
const pageLine = (r: ImportOutcome): string => (r.outcome === "stored" && r.item.kind === "skill" ? `stored skill ${r.item.name} from ${r.item.source}` : importLine(r));

/** POST /api/v1/plugins/import, after the request guards: stores the selected items as the page's factory user. */
export async function writePluginsImport(d: ApiDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const keys = selection(body);
  if (typeof keys === "string") return { status: 400, value: { error: keys } };
  const added_by = await p.principal();
  if (added_by === null) return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  const { found, errors } = await scanAll();
  const byKey = new Map(found.map((f) => [keyOf(f), f]));
  const o = { db: storeSql(d.store), now: () => d.clock.now().toISOString(), d, added_by };
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const results = [];
  for (const key of keys) {
    const item = byKey.get(keyOf(key));
    if (item === undefined) {
      results.push({ ...key, outcome: "not_found", rules: [], line: await text(`not found ${key.kind} ${key.name} from ${key.source}`) });
      continue;
    }
    const r = await importOne(o, item);
    results.push({ ...key, outcome: r.outcome, rules: r.outcome === "refused" ? r.rules : [], line: await text(pageLine(r)) });
  }
  return { status: 200, value: { results, errors: await Promise.all(errors.map(async (e) => ({ source: e.source, message: await text(e.message) }))) } };
}
