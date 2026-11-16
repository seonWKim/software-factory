// The Plugins page's import (design 11-plugin-import, 2026-11-15, phase 2): GET /api/v1/plugins/import lists the
// skills and MCP servers the user-level Claude Code and Codex configs hold (scanUserConfigs, the scan of `factory
// plugins import`), each with whether it is already stored, and writes nothing. POST /api/v1/plugins/import with
// `{ "items": [{ "kind", "source", "name" }] }` scans again and stores the selected items through the CLI's importer
// (importItem): a skill as an `ext_skill_refs` pointer, an MCP server, after the three `pack add` scans, as a pending
// `ext_packs_entries` pointer (its file, key and SHA-256; never a copy). The browser names items only; their
// descriptors come from the server's own scan, so no descriptor, env value or header value is ever sent or returned.
// added_by is the page's factory user (403 when there is none). Nothing is started, approved or granted. Each result's
// `line` is plain words without the CLI's sha256 (design 11-plugin-import, 2026-11-16): "stored skill deploy from
// codex". The page offers the sources and kinds it has labels for (PAGE_SOURCES, PAGE_KINDS); the CLI imports the
// others. server.ts runs the request guards first: Host and the CSRF token for the read; Host, Origin, Content-Type,
// CSRF token, body size and JSON for the write.

import { storeSql } from "../impl/store/sql/store-sql.js";
import { type ImportOutcome, importItem, importLine, isStored, sharedKeys } from "../import/import-plugins.js";
import { type ImportKind, type ImportSource, scanUserConfigs } from "../import/scan.js";
import { canonicalJson } from "../packs/pack-entries.store.js";
import { scanDescriptor } from "../packs/pack-scans.js";
import { skillFolderPath } from "../runtime/capabilities/capabilities.js";
import type { ApiDeps, ApiResult } from "./api.js";
import type { UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const PLUGINS_IMPORT_PATH = "/api/v1/plugins/import";

/** The most items one POST may name. */
const MAX_ITEMS = 500;

/** The sources and kinds the page lists and imports. */
const PAGE_SOURCES: readonly ImportSource[] = ["claude", "codex"];
const PAGE_KINDS: readonly ImportKind[] = ["skill", "mcp_server"];

/** What the browser names an item by: its kind, its source and its name (a skill's folder name). */
interface ItemKey {
  kind: ImportKind;
  source: string;
  name: string;
}

const keyOf = (i: ItemKey): string => `${i.kind}\n${i.source}\n${i.name}`;

/**
 * Everything both user configs hold, under the owner's home folder: `~` as the Plugins page's skill folders resolve
 * it (skillFolderPath), so the UI layer holds no OS call of its own. Reads only.
 */
const scanAll = () => scanUserConfigs({ home: skillFolderPath("~", "/"), sources: PAGE_SOURCES, kinds: PAGE_KINDS });

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
    items.push({
      kind: item.kind,
      source: item.source,
      name: await text(item.name),
      path: item.kind === "mcp_server" ? null : await text(item.path),
      env_keys: item.kind === "mcp_server" ? keyNames(item.descriptor.env_keys) : [],
      header_keys: item.kind === "mcp_server" ? keyNames(item.descriptor.header_keys) : [],
      imported: await isStored(db, item),
      // The scans a POST would run: an item that fails one cannot be imported.
      refused: item.kind === "mcp_server" ? await scanDescriptor(d.scanner, item.descriptor, canonicalJson(item.descriptor)) : [],
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
    if (!(PAGE_KINDS as readonly unknown[]).includes(o.kind)) return `each item's kind must be ${PAGE_KINDS.join(" or ")}`;
    if (!(PAGE_SOURCES as readonly unknown[]).includes(o.source)) return `each item's source must be ${PAGE_SOURCES.join(" or ")}`;
    if (typeof o.name !== "string" || o.name === "") return "each item's name must be a non-empty string";
    out.push({ kind: o.kind as ImportKind, source: o.source as string, name: o.name });
  }
  return out;
}

/** An item's line for the page: importLine without the stored skill's sha256. */
const pageLine = (r: ImportOutcome): string => (r.item.kind !== "mcp_server" && (r.outcome === "stored" || r.outcome === "updated") ? `${r.outcome} ${r.item.kind} ${r.item.name} from ${r.item.source}` : importLine(r));

/** POST /api/v1/plugins/import, after the request guards: stores the selected items as the page's factory user. */
export async function writePluginsImport(d: ApiDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const keys = selection(body);
  if (typeof keys === "string") return { status: 400, value: { error: keys } };
  const added_by = await p.principal();
  if (added_by === null) return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  const { found, errors } = await scanAll();
  const byKey = new Map(found.map((f) => [keyOf(f), f]));
  const shared = sharedKeys(found);
  const o = { db: storeSql(d.store), now: () => d.clock.now().toISOString(), scanner: d.scanner, added_by };
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const results = [];
  for (const key of keys) {
    const item = byKey.get(keyOf(key));
    if (item === undefined) {
      results.push({ ...key, outcome: "not_found", rules: [], line: await text(`not found ${key.kind} ${key.name} from ${key.source}`) });
      continue;
    }
    const r = await importItem(o, item, shared);
    results.push({ ...key, outcome: r.outcome, rules: r.outcome === "refused" ? r.rules : [], line: await text(pageLine(r)) });
  }
  return { status: 200, value: { results, errors: await Promise.all(errors.map(async (e) => ({ source: e.source, message: await text(e.message) }))) } };
}
