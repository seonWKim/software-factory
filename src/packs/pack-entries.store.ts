// Pack tool and MCP server entries (design 11-packs, issue #588): `factory pack add <path>` reads a pack's
// `tools/*.json` (kind `tool`) and `mcp_servers/*.json` (kind `mcp_server`), runs the three scans (pack-scans.ts) on
// each, and stores each passing one in `ext_packs_entries` as `pending`. A failing one is refused and nothing is
// stored for it. Nothing here starts a process or calls a tool: a stored entry is data until a later phase approves it.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { insertOrSkip } from "../bus/index.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { SqlDriver } from "../state/index.js";
import { type Json, scanDescriptor } from "./pack-scans.js";

export type PackEntryKind = "tool" | "mcp_server";

/** Each kind's folder in a pack. */
const KIND_DIRS: readonly [PackEntryKind, string][] = [
  ["tool", "tools"],
  ["mcp_server", "mcp_servers"],
];

/** What an add stores; the row also gets its ID, status `pending` and created_at and updated_at from the Clock. */
interface NewPackEntry {
  readonly kind: PackEntryKind;
  readonly name: string;
  readonly description_hash: string;
  /** The scanned canonical JSON. */
  readonly descriptor: string;
  /** The environment variable a tool's credential comes from; never its value. */
  readonly credential_name: string | null;
  /** The adder's user ID, never a display name. */
  readonly added_by: string;
}

/** What the add did with one descriptor file. A refused one is named by its file: its descriptor's text is never printed. */
export type AddOutcome =
  | { readonly outcome: "stored" | "already_added"; readonly kind: PackEntryKind; readonly name: string; readonly description_hash: string }
  | { readonly outcome: "refused"; readonly kind: PackEntryKind; readonly name: string; readonly rules: readonly string[] };

/** JSON with every object's keys sorted, no spaces: one text per descriptor whatever its file's layout. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export class PackEntriesStore {
  constructor(
    private readonly db: SqlDriver,
    /** The add's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /** Stores the entry as pending; false when the same kind, name and description_hash is already stored. */
  async insert(e: NewPackEntry): Promise<boolean> {
    const at = this.now();
    // The ID follows from the unique key, so a rerun or a second worker makes the same row.
    const id = `pe_${sha256(`${e.kind}\n${e.name}\n${e.description_hash}`).slice(0, 32)}`;
    return insertOrSkip(
      this.db,
      this.db.dialect.name,
      "ext_packs_entries (id, kind, name, description_hash, descriptor, credential_name, status, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      [id, e.kind, e.name, e.description_hash, e.descriptor, e.credential_name, e.added_by, at, at],
    );
  }

  /**
   * The entry of `kind` and `name` added last: its description is the current one, the only one an approval can
   * turn on (the pin, design 11-packs). Null when none is stored.
   */
  async current(kind: PackEntryKind, name: string): Promise<StoredEntry | null> {
    const [r] = await this.db.all(
      "SELECT description_hash, descriptor, credential_name FROM ext_packs_entries WHERE kind = ? AND name = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      [kind, name],
    );
    if (!r) return null;
    const descriptor = JSON.parse(String(r.descriptor)) as { read_only?: unknown };
    const credential_name = r.credential_name === null ? null : String(r.credential_name);
    return { kind, name, description_hash: String(r.description_hash), credential_name, read_only: descriptor.read_only === true };
  }

  /** Every stored description_hash of `kind` and `name`, oldest first. */
  async hashes(kind: PackEntryKind, name: string): Promise<string[]> {
    const rows = await this.db.all("SELECT description_hash FROM ext_packs_entries WHERE kind = ? AND name = ? ORDER BY created_at, id", [kind, name]);
    return rows.map((r) => String(r.description_hash));
  }
}

/** One stored description of an entry: what an approval is keyed by. */
export interface PackEntryRef {
  readonly kind: PackEntryKind;
  readonly name: string;
  readonly description_hash: string;
}

/** A stored entry as the grant check reads it: `read_only` is the descriptor's own `read_only: true`. */
export interface StoredEntry extends PackEntryRef {
  readonly credential_name: string | null;
  readonly read_only: boolean;
}

export const PACK_ENTRY_KINDS: readonly PackEntryKind[] = KIND_DIRS.map(([kind]) => kind);

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** One descriptor file: scanned, then stored or refused. Rule `invalid_descriptor`: not a JSON object with a name. */
async function addOne(store: PackEntriesStore, scanner: EgressScanner, kind: PackEntryKind, path: string, file: string, added_by: string): Promise<AddOutcome> {
  let descriptor: Json;
  try {
    descriptor = JSON.parse(await readFile(path, "utf8")) as Json;
  } catch {
    return { outcome: "refused", kind, name: file, rules: ["invalid_descriptor"] };
  }
  const name = descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor) ? descriptor.name : undefined;
  if (typeof name !== "string" || name.trim() === "") return { outcome: "refused", kind, name: file, rules: ["invalid_descriptor"] };
  const canonical = canonicalJson(descriptor);
  const rules = await scanDescriptor(scanner, descriptor, canonical);
  if (rules.length > 0) return { outcome: "refused", kind, name: file, rules };
  const credential = (descriptor as { credential?: Json }).credential;
  const description_hash = sha256(canonical);
  const stored = await store.insert({
    kind, name, description_hash, descriptor: canonical, credential_name: typeof credential === "string" ? credential : null, added_by,
  });
  return { outcome: stored ? "stored" : "already_added", kind, name, description_hash };
}

/** Adds every tool and MCP server descriptor of the pack at `path`, tools first, each folder in file-name order. */
export async function addPack(o: { path: string; store: PackEntriesStore; scanner: EgressScanner; added_by: string }): Promise<AddOutcome[]> {
  const out: AddOutcome[] = [];
  for (const [kind, folder] of KIND_DIRS) {
    const dir = join(o.path, folder);
    for (const file of await jsonFiles(dir)) out.push(await addOne(o.store, o.scanner, kind, join(dir, file), file, o.added_by));
  }
  return out;
}

/** The add's line for one entry: stored, already added, or refused with the failed rules' names. */
export function addLine(r: AddOutcome): string {
  const what = `${r.kind === "tool" ? "tool" : "MCP server"} ${r.name}`;
  if (r.outcome === "refused") return `refused ${what}: ${r.rules.join(", ")}`;
  if (r.outcome === "already_added") return `already added ${what}`;
  return `stored ${what} as pending (description_hash ${r.description_hash.slice(0, 12)})`;
}
