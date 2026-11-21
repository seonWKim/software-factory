// `factory plugins import` storage (design 11-plugin-import), shared by the CLI and the Plugins page's Import. Every
// item is stored as a pointer, never a copy:
// - a skill or command: one `ext_skill_refs` row per (source, path) with its kind, name and SHA-256; a changed file
//   updates that row (`updated skill <name>`), never adds a second one;
// - an MCP server, after the same three scans `factory pack add` runs (pack-scans.ts): one pending
//   `ext_packs_entries` pointer row (source, file, key and the SHA-256 of its allow-listed descriptor) through
//   PackEntriesStore.storePointer. A changed entry is pending again. No command, args, env or URL is stored.
// Nothing here starts, approves or grants an MCP server, and nothing writes to a scanned file.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { insertOrSkip } from "../bus/index.js";
import type { Loaded } from "../compose.js";
import { Plugins } from "../plugin-set.js";
import { cliUserConfig } from "../core/config.js";
import { type CliEnvironment, cliIdentity } from "../core/local-cli.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../packs/pack-entries.store.js";
import { scanDescriptor } from "../packs/pack-scans.js";
import type { SqlDriver } from "../state/index.js";
import type { Found, FoundFile, FoundMcpServer } from "./scan.js";

export type ImportOutcome =
  | { readonly outcome: "stored" | "updated" | "already_added"; readonly item: Found }
  | { readonly outcome: "refused"; readonly item: Found; readonly rules: readonly string[] };

export class SkillRefsStore {
  constructor(
    private readonly db: SqlDriver,
    /** The import's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /** Stores the pointer, or updates the one stored for its source and path when its SHA-256 (or kind) changed. */
  async insert(s: FoundFile, added_by: string): Promise<"stored" | "updated" | "already_added"> {
    const at = this.now();
    // The ID follows from the unique key, so a rerun or a second worker makes the same row.
    const id = `sr_${createHash("sha256").update(`${s.source}\n${s.path}`).digest("hex").slice(0, 32)}`;
    if (await insertOrSkip(
      this.db,
      "ext_skill_refs (id, source, kind, name, path, sha256, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, s.source, s.kind, s.name, s.path, s.sha256, added_by, at, at],
    )) return "stored";
    const changed = await this.db.run(
      "UPDATE ext_skill_refs SET kind = ?, name = ?, sha256 = ?, updated_at = ? WHERE source = ? AND path = ? AND (sha256 <> ? OR kind <> ?)",
      [s.kind, s.name, s.sha256, at, s.source, s.path, s.sha256, s.kind],
    );
    return changed === 1 ? "updated" : "already_added";
  }

  /** True when this exact file (its source, path, kind and SHA-256) is stored. */
  async has(s: FoundFile): Promise<boolean> {
    const rows = await this.db.all("SELECT 1 AS hit FROM ext_skill_refs WHERE source = ? AND path = ? AND kind = ? AND sha256 = ?", [s.source, s.path, s.kind, s.sha256]);
    return rows.length > 0;
  }
}

/** The keys more than one source holds among `found`: such a server is named `<key>@<source>`. */
export function sharedKeys(found: readonly Found[]): Set<string> {
  const sources = new Map<string, Set<string>>();
  for (const f of found) if (f.kind === "mcp_server") sources.set(f.name, (sources.get(f.name) ?? new Set()).add(f.source));
  return new Set([...sources].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** What an import writes with: the store, its time, the egress scanner and the importer's user ID. */
export interface ImportDeps {
  readonly db: SqlDriver;
  readonly now: () => string;
  readonly scanner: EgressScanner;
  readonly added_by: string;
}

/** True when this exact item is stored: a file's pointer with its SHA-256, an MCP server's pointer with its hash. */
export async function isStored(db: SqlDriver, item: Found): Promise<boolean> {
  if (item.kind !== "mcp_server") return new SkillRefsStore(db, () => "").has(item);
  const rows = await db.all(
    "SELECT 1 AS hit FROM ext_packs_entries WHERE kind = 'mcp_server' AND source = ? AND source_file = ? AND source_key = ? AND description_hash = ?",
    [item.source, item.file, item.name, descriptionHash(item.descriptor)],
  );
  return rows.length > 0;
}

async function importServer(d: ImportDeps, item: FoundMcpServer, shared: boolean): Promise<ImportOutcome> {
  const rules = await scanDescriptor(d.scanner, item.descriptor, canonicalJson(item.descriptor));
  if (rules.length > 0) return { outcome: "refused", item, rules };
  const r = await new PackEntriesStore(d.db, d.now).storePointer(
    { source: item.source, file: item.file, key: item.name, description_hash: descriptionHash(item.descriptor), added_by: d.added_by },
    shared,
  );
  return { outcome: r.outcome, item };
}

/** Stores one item; an MCP server that fails a scan is refused and not stored. `shared`: sharedKeys of the scan. */
export async function importItem(d: ImportDeps, item: Found, shared: ReadonlySet<string>): Promise<ImportOutcome> {
  if (item.kind === "mcp_server") return importServer(d, item, shared.has(item.name));
  return { outcome: await new SkillRefsStore(d.db, d.now).insert(item, d.added_by), item };
}

/**
 * Opens the configured store (migrated) and stores `found` as the CLI identity's user ID, with the configured
 * clock and egress scanner, through the same registry as build(). Throws on a bad `cli_user` config.
 */
export async function storeFound(loaded: Loaded, env: CliEnvironment, found: readonly Found[]): Promise<ImportOutcome[]> {
  const added_by = cliIdentity(cliUserConfig(loaded.file), env).user;
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const scanner = await p.scanner(secrets);
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const store = await p.store(secrets, clock);
  try {
    await store.migrate();
    const d: ImportDeps = { db: storeSql(store), now: () => clock.now().toISOString(), scanner, added_by };
    const shared = sharedKeys(found);
    const out: ImportOutcome[] = [];
    for (const item of found) out.push(await importItem(d, item, shared));
    return out;
  } finally {
    await store.close();
  }
}

const what = (i: Found): string => `${i.kind} ${i.name} from ${i.source}`;

/** The dry run's line for one found item. */
export const foundLine = (i: Found): string => `found ${what(i)}`;

/** The import's line for one item: stored, updated, already added, or refused with the failed rules' names. */
export function importLine(r: ImportOutcome): string {
  if (r.outcome === "refused") return `refused ${what(r.item)}: ${r.rules.join(", ")}`;
  if (r.outcome === "already_added") return `already added ${what(r.item)}`;
  if (r.item.kind === "mcp_server") return r.outcome === "updated" ? `updated ${what(r.item)}: changed, pending again` : `stored ${what(r.item)} as pending`;
  return `${r.outcome} ${what(r.item)} (sha256 ${r.item.sha256.slice(0, 12)})`;
}
