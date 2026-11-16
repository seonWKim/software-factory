// Pack tool and MCP server entries (design 11-packs, issue #588): `factory pack add <path>` reads a pack's
// `tools/*.json` (kind `tool`) and `mcp_servers/*.json` (kind `mcp_server`), runs the three scans (pack-scans.ts) on
// each, and stores each passing one in `ext_packs_entries` as `pending`. A failing one is refused and nothing is
// stored for it. Nothing here starts a process or calls a tool: a stored entry is data until a later phase approves it.
// A tool's module beside its descriptor (`tools/<file>.tool.js`) is pinned too: its SHA-256 is stored as module_hash
// and joins the description_hash, so a changed module is a new entry that needs its own approval.
//
// An imported MCP server (design 11-plugin-import) is a pointer row: its source label, the file that holds it, its key
// there and the SHA-256 of its allow-listed descriptor, never a copy of the descriptor. Its descriptor is read from
// the file each time the entry is read (`current`): gone is `missing`, another hash is `changed`, else `ok`.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { insertOrSkip } from "../bus/index.js";
import { readServerDescriptor } from "../import/mcp-servers.js";
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
  /** The SHA-256 of the tool's module bytes; null for a tool with no module and for an MCP server. */
  readonly module_hash: string | null;
  /** The scanned canonical JSON. */
  readonly descriptor: string;
  /** The environment variable a tool's credential comes from; never its value. */
  readonly credential_name: string | null;
  /** The adder's user ID, never a display name. */
  readonly added_by: string;
}

/** What the add did with one descriptor file. A refused one is named by its file: its descriptor's text is never printed. */
export type AddOutcome =
  | { readonly outcome: "stored" | "already_added"; readonly kind: PackEntryKind; readonly name: string; readonly description_hash: string; readonly module_hash: string | null }
  | { readonly outcome: "refused"; readonly kind: PackEntryKind; readonly name: string; readonly rules: readonly string[] };

/** JSON with every object's keys sorted, no spaces: one text per descriptor whatever its file's layout. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A pack tool's module, beside its descriptor: `tools/<file>.tool.js`. */
export const PACK_TOOL_MODULE = ".tool.js";

/** A tool module's module_hash: the SHA-256 of its bytes. */
export const moduleHash = (bytes: Uint8Array): string => sha256(bytes);

/**
 * A descriptor's description_hash, what an approval is keyed by: the SHA-256 of its canonical JSON, or with a
 * module, of that JSON and the module's hash. With no module it is the same value as before modules were pinned.
 */
export const descriptionHash = (descriptor: Json, module_hash: string | null = null): string => {
  const canonical = canonicalJson(descriptor);
  return sha256(module_hash === null ? canonical : `${canonical}\nmodule_hash:${module_hash}`);
};

/** The module beside a tool's descriptor file; null when there is none. Read at add, startup and every call. */
export async function readModuleHash(file: string): Promise<string | null> {
  try {
    return moduleHash(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

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
      "ext_packs_entries (id, kind, name, description_hash, module_hash, descriptor, credential_name, status, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      [id, e.kind, e.name, e.description_hash, e.module_hash, e.descriptor, e.credential_name, e.added_by, at, at],
    );
  }

  /**
   * The entry of `kind` and `name` added last: its description is the current one, the only one an approval can
   * turn on (the pin, design 11-packs). An imported MCP server's descriptor is read from its file now. Null when
   * none is stored.
   */
  async current(kind: PackEntryKind, name: string): Promise<StoredEntry | null> {
    const [r] = await this.db.all(
      "SELECT description_hash, module_hash, descriptor, credential_name, source, source_file, source_key FROM ext_packs_entries WHERE kind = ? AND name = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      [kind, name],
    );
    if (!r) return null;
    const ref = storedRef(kind, name, r);
    const credential_name = r.credential_name === null ? null : String(r.credential_name);
    if (r.source_file === null || r.source_file === undefined) {
      const descriptor = JSON.parse(String(r.descriptor)) as Record<string, Json>;
      return { ...ref, credential_name, read_only: descriptor.read_only === true, descriptor, imported: null };
    }
    const pointer: McpPointer = { source: String(r.source), file: String(r.source_file), key: String(r.source_key) };
    const live = await readPointer(pointer);
    const state: PointerState = live === null ? "missing" : live.description_hash === ref.description_hash ? "ok" : "changed";
    return { ...ref, credential_name, read_only: false, descriptor: live?.descriptor ?? {}, imported: { ...pointer, state } };
  }

  /** The names of every stored entry of `kind`, sorted. */
  async names(kind: PackEntryKind): Promise<string[]> {
    return (await this.db.all("SELECT DISTINCT name FROM ext_packs_entries WHERE kind = ? ORDER BY name", [kind])).map((r) => String(r.name));
  }

  /**
   * Stores an imported MCP server as a pending pointer: its source, file, key and description_hash. The pointer
   * stored before keeps its row and name: the same hash is `already_added` (a `missing` row is pending again), another
   * hash replaces the stored one and the row is pending again, so the old hash's approval no longer applies. A new
   * pointer is named by its key, with `@<source>` added when another source holds the same key (`shared`) or the
   * name is taken.
   */
  async storePointer(p: McpPointer & { description_hash: string; added_by: string }, shared: boolean): Promise<{ outcome: "stored" | "updated" | "already_added"; name: string }> {
    const at = this.now();
    const [row] = await this.db.all(
      "SELECT id, name, description_hash FROM ext_packs_entries WHERE kind = 'mcp_server' AND source = ? AND source_file = ? AND source_key = ?",
      [p.source, p.file, p.key],
    );
    if (row) {
      const name = String(row.name);
      if (row.description_hash === p.description_hash) {
        await this.db.run("UPDATE ext_packs_entries SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'missing'", [at, String(row.id)]);
        return { outcome: "already_added", name };
      }
      const changed = await this.db.run(
        "UPDATE ext_packs_entries SET description_hash = ?, status = 'pending', updated_at = ? WHERE id = ? AND description_hash = ?",
        [p.description_hash, at, String(row.id), String(row.description_hash)],
      );
      return { outcome: changed === 1 ? "updated" : "already_added", name };
    }
    const taken = (await this.db.all("SELECT 1 AS hit FROM ext_packs_entries WHERE kind = 'mcp_server' AND name = ? LIMIT 1", [p.key])).length > 0;
    const name = shared || taken ? `${p.key}@${p.source.replace(/\s+/g, "-")}` : p.key;
    // The ID follows from the pointer, so a rerun or a second worker makes the same row.
    const id = `pe_${sha256(`mcp_server\n${p.source}\n${p.file}\n${p.key}`).slice(0, 32)}`;
    const stored = await insertOrSkip(
      this.db,
      "ext_packs_entries (id, kind, name, description_hash, module_hash, descriptor, credential_name, source, source_file, source_key, status, added_by, created_at, updated_at) VALUES (?, 'mcp_server', ?, ?, NULL, NULL, NULL, ?, ?, ?, 'pending', ?, ?, ?)",
      [id, name, p.description_hash, p.source, p.file, p.key, p.added_by, at, at],
    );
    return { outcome: stored ? "stored" : "already_added", name };
  }

  /** Every stored description of `kind` and `name`, oldest first. */
  async refs(kind: PackEntryKind, name: string): Promise<StoredRef[]> {
    const rows = await this.db.all("SELECT description_hash, module_hash FROM ext_packs_entries WHERE kind = ? AND name = ? ORDER BY created_at, id", [kind, name]);
    return rows.map((r) => storedRef(kind, name, r));
  }
}

const storedRef = (kind: PackEntryKind, name: string, r: Record<string, unknown>): StoredRef => ({
  kind, name, description_hash: String(r.description_hash), module_hash: r.module_hash === null || r.module_hash === undefined ? null : String(r.module_hash),
});

/** One stored description of an entry: what an approval is keyed by. */
export interface PackEntryRef {
  readonly kind: PackEntryKind;
  readonly name: string;
  readonly description_hash: string;
}

/** A stored description and its tool module's hash (null: no module), as the add and approve lines show it. */
export interface StoredRef extends PackEntryRef {
  readonly module_hash: string | null;
}

/** Where an imported MCP server lives: its source label, the file that holds it and its key there. */
export interface McpPointer {
  readonly source: string;
  readonly file: string;
  readonly key: string;
}

/** A pointer read now: `ok` (its descriptor hashes to the stored hash), `changed` (another hash) or `missing` (gone). */
export type PointerState = "ok" | "changed" | "missing";

/** A stored entry as the grant check reads it: `read_only` is the descriptor's own `read_only: true`. */
export interface StoredEntry extends StoredRef {
  readonly credential_name: string | null;
  readonly read_only: boolean;
  /**
   * The scanned descriptor, parsed: what an approved MCP server starts from (`packMcpServer`). An imported server's
   * is read from its file now ({} when it is missing).
   */
  readonly descriptor: Readonly<Record<string, Json>>;
  /** An imported MCP server's pointer and its state now; null for a pack's entry. */
  readonly imported: (McpPointer & { readonly state: PointerState }) | null;
}

/** The pointer's descriptor in its file now and its description_hash; null when the file or the entry is gone. */
export async function readPointer(p: McpPointer): Promise<{ descriptor: Record<string, Json>; description_hash: string } | null> {
  const descriptor = await readServerDescriptor(p.source, p.file, p.key);
  return descriptor === null ? null : { descriptor, description_hash: descriptionHash(descriptor) };
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
  const module_hash = kind === "tool" ? await readModuleHash(`${path.slice(0, -".json".length)}${PACK_TOOL_MODULE}`) : null;
  const description_hash = descriptionHash(descriptor, module_hash);
  const stored = await store.insert({
    kind, name, description_hash, module_hash, descriptor: canonical, credential_name: typeof credential === "string" ? credential : null, added_by,
  });
  return { outcome: stored ? "stored" : "already_added", kind, name, description_hash, module_hash };
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
  return `stored ${what} as pending (${hashesText(r)})`;
}

/** The hashes a line shows: the description_hash, and the module_hash beside it when the tool has a module. */
export function hashesText(r: { readonly description_hash: string; readonly module_hash: string | null }): string {
  return `description_hash ${r.description_hash.slice(0, 12)}${r.module_hash === null ? "" : `, module_hash ${r.module_hash.slice(0, 12)}`}`;
}
