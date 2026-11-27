// `factory plugins import` storage (design 11-plugin-import), shared by the CLI and the Plugins page's Import. Every
// item is stored as a pointer, never a copy:
// - a skill or command: one `ext_skill_refs` row per (source, path) with its kind, name and SHA-256; a changed file
//   updates that row (`updated skill <name>`), never adds a second one. A skill's SKILL.md text goes through the egress
//   scan first (a failure is refused: no ref, no version); then, when its folder hash (capabilities skillVersion) is
//   not its latest version's, the next `ext_skill_versions` row keeps the text, with its gate row in pending (design
//   07-self-improvement). A command gets no version;
// - an MCP server, after the same three scans `factory pack add` runs (pack-scans.ts): one pending
//   `ext_packs_entries` pointer row (source, file, key and the SHA-256 of its allow-listed descriptor) through
//   PackEntriesStore.storePointer. A changed entry is pending again. No command, args, env or URL is stored.
// Nothing here starts, approves or grants an MCP server, and nothing writes to a scanned file. After the items are
// stored, `factory plugins import` runs one new-version gate pass (gatedImport, src/skill-evals.ts): each
// pending gate, and each running one whose lease ended, has its skill's suite run on its version.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { insertOrSkip } from "../bus/index.js";
import type { Loaded } from "../load-config.js";
import { cliUserConfig } from "../core/config.js";
import { type CliEnvironment, cliIdentity } from "../core/local-cli.js";
import { SqlSkillEvalStore } from "../impl/store/sql/skill-evals.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { skillVersion } from "../runtime/capabilities/capabilities.js";
import { gatedImport } from "../skill-evals.js";
import type { Timestamp } from "../core/types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../packs/pack-entries.store.js";
import { scanDescriptor } from "../packs/pack-scans.js";
import type { SqlDriver } from "../state/index.js";
import type { Found, FoundFile, FoundMcpServer } from "./scan.js";

export type ImportOutcome =
  | { readonly outcome: "stored" | "updated" | "already_added"; readonly item: Found }
  | { readonly outcome: "refused"; readonly item: Found; readonly rules: readonly string[] };

/** A ref's ID: it follows from the unique key, so a rerun or a second worker makes the same row. */
export const skillRefId = (s: Pick<FoundFile, "source" | "path">): string => `sr_${createHash("sha256").update(`${s.source}\n${s.path}`).digest("hex").slice(0, 32)}`;

export class SkillRefsStore {
  constructor(
    private readonly db: SqlDriver,
    /** The import's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /** Stores the pointer, or updates the one stored for its source and path when its SHA-256 (or kind) changed. */
  async insert(s: FoundFile, added_by: string): Promise<"stored" | "updated" | "already_added"> {
    const at = this.now();
    const id = skillRefId(s);
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

  /** The stored path (a skill's SKILL.md) of ref `id`; null for an unknown ref. */
  async pathOf(id: string): Promise<string | null> {
    const [row] = await this.db.all("SELECT path FROM ext_skill_refs WHERE id = ?", [id]);
    return row ? String(row.path) : null;
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

/**
 * A skill: its SKILL.md text is egress-scanned (a failure is refused, nothing stored), its ref stored or updated, and
 * the next version recorded when the folder hash changed. An unreadable file or folder records no version and does
 * not fail the import. A command is only its ref. Skill files are read, never written.
 */
async function importFile(d: ImportDeps, item: FoundFile): Promise<ImportOutcome> {
  const text = item.kind === "skill" ? await readFile(item.path, "utf8").catch(() => null) : null;
  if (text !== null) {
    const scan = await d.scanner.scan("tool_result", text);
    if (!scan.clean) return { outcome: "refused", item, rules: [...new Set(scan.findings.map((f) => f.rule))] };
  }
  const outcome = await new SkillRefsStore(d.db, d.now).insert(item, d.added_by);
  const folder_hash = text === null ? null : await skillVersion(dirname(item.path)).catch(() => null);
  if (text !== null && folder_hash !== null) {
    await new SqlSkillEvalStore(d.db, () => d.now() as Timestamp).recordSkillVersion({ ref_id: skillRefId(item), folder_hash, text, source: item.source });
  }
  return { outcome, item };
}

/** Stores one item; an MCP server or skill that fails a scan is refused and not stored. `shared`: sharedKeys of the scan. */
export async function importItem(d: ImportDeps, item: Found, shared: ReadonlySet<string>): Promise<ImportOutcome> {
  return item.kind === "mcp_server" ? importServer(d, item, shared.has(item.name)) : importFile(d, item);
}

/**
 * Opens the configured store (migrated) and stores `found` as the CLI identity's user ID, with the configured
 * clock and egress scanner, through the same registry as build(), then runs one gate pass over the store's due
 * version gates. Throws on a bad `cli_user` config.
 */
export async function storeFound(loaded: Loaded, env: CliEnvironment, found: readonly Found[]): Promise<ImportOutcome[]> {
  const added_by = cliIdentity(cliUserConfig(loaded.file), env).user;
  return gatedImport(loaded, async ({ store, clock, scanner }) => {
    const d: ImportDeps = { db: storeSql(store), now: () => clock.now().toISOString(), scanner, added_by };
    const shared = sharedKeys(found);
    const result: ImportOutcome[] = [];
    for (const item of found) result.push(await importItem(d, item, shared));
    const refs = new SkillRefsStore(d.db, d.now);
    return { result, refPath: (id) => refs.pathOf(id) };
  });
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
