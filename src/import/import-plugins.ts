// `factory plugins import` storage (design 11-plugin-import): each found MCP server becomes a pending
// `ext_packs_entries` row of kind `mcp_server` through PackEntriesStore.insert, after the same three scans
// `factory pack add` runs (pack-scans.ts); each found skill becomes one `ext_skill_refs` row (source, name, path,
// SHA-256). Both inserts skip a row that is already stored, so a second run adds nothing. Nothing here starts,
// approves or grants an MCP server.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { insertOrSkip } from "../bus/index.js";
import { type Loaded, Plugins } from "../compose.js";
import { cliUserConfig } from "../core/config.js";
import { type CliEnvironment, cliIdentity } from "../core/local-cli.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../packs/pack-entries.store.js";
import { scanDescriptor } from "../packs/pack-scans.js";
import type { SqlDriver } from "../state/index.js";
import type { Found, FoundSkill } from "./scan.js";

export type ImportOutcome =
  | { readonly outcome: "stored" | "already_added"; readonly item: Found }
  | { readonly outcome: "refused"; readonly item: Found; readonly rules: readonly string[] };

export class SkillRefsStore {
  constructor(
    private readonly db: SqlDriver,
    /** The import's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /** Stores the reference; false when the same source, path and sha256 is already stored. */
  async insert(s: FoundSkill, added_by: string): Promise<boolean> {
    // The ID follows from the unique key, so a rerun or a second worker makes the same row.
    const id = `sr_${createHash("sha256").update(`${s.source}\n${s.path}\n${s.sha256}`).digest("hex").slice(0, 32)}`;
    return insertOrSkip(
      this.db,
      "ext_skill_refs (id, source, name, path, sha256, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, s.source, s.name, s.path, s.sha256, added_by, this.now()],
    );
  }
}

/** Stores every found item in order; an MCP server that fails a scan is refused and not stored. */
async function importFound(o: { db: SqlDriver; now: () => string; scanner: EgressScanner; added_by: string; found: readonly Found[] }): Promise<ImportOutcome[]> {
  const entries = new PackEntriesStore(o.db, o.now);
  const refs = new SkillRefsStore(o.db, o.now);
  const out: ImportOutcome[] = [];
  for (const item of o.found) {
    if (item.kind === "skill") {
      out.push({ outcome: (await refs.insert(item, o.added_by)) ? "stored" : "already_added", item });
      continue;
    }
    const canonical = canonicalJson(item.descriptor);
    const rules = await scanDescriptor(o.scanner, item.descriptor, canonical);
    if (rules.length > 0) {
      out.push({ outcome: "refused", item, rules });
      continue;
    }
    const stored = await entries.insert({
      kind: "mcp_server", name: item.name, description_hash: descriptionHash(item.descriptor), module_hash: null, descriptor: canonical, credential_name: null, added_by: o.added_by,
    });
    out.push({ outcome: stored ? "stored" : "already_added", item });
  }
  return out;
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
    return await importFound({ db: storeSql(store), now: () => clock.now().toISOString(), scanner, added_by, found });
  } finally {
    await store.close();
  }
}

const what = (i: Found): string => `${i.kind} ${i.name} from ${i.source}`;

/** The dry run's line for one found item. */
export const foundLine = (i: Found): string => `found ${what(i)}`;

/** The import's line for one item: stored, already added, or refused with the failed rules' names. */
export function importLine(r: ImportOutcome): string {
  if (r.outcome === "refused") return `refused ${what(r.item)}: ${r.rules.join(", ")}`;
  if (r.outcome === "already_added") return `already added ${what(r.item)}`;
  return r.item.kind === "skill" ? `stored ${what(r.item)} (sha256 ${r.item.sha256.slice(0, 12)})` : `stored ${what(r.item)} as pending`;
}
