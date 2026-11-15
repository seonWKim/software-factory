// The tools of an approved imported MCP server (design 11-plugin-import, phase 3). The Plugins read (the UI) writes
// one `requested` `ext_mcp_tool_lists` row per approved imported server whose current description has none; a worker
// claims it (requested to running, a conditional update, so one worker starts the server), reads the approval again,
// starts the server through the injected `start` (startPackMcpServer: an empty env, no credential, `initialize` and
// `tools/list` only), keeps the tool names and stops it. The row ends `listed`, `not_stdio`, `did_not_start` or
// `not_approved`. No tool description and no error text is stored. Approvals and entries are only read.
//
// Owner answer 1: an imported server is never started for an agent run (importedMcpRefusals refuses it as
// `not_started`). Owner answer 3: the server starts once per request, in the worker, never in the UI process.

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { insertOrSkip } from "../bus/index.js";
import type { PackMcpServer } from "../interfaces/agent-runner.js";
import { PackApprovalsStore, packGrantName } from "../packs/pack-approvals.store.js";
import { PackEntriesStore, type PackEntryRef, type StoredEntry } from "../packs/pack-entries.store.js";
import { type PackRefusal, packMcpServer } from "../packs/pack-grants.js";
import type { SqlDriver } from "../state/index.js";
import { IMPORT_SOURCES } from "./scan.js";

export type McpToolListStatus = "requested" | "running" | "listed" | "not_stdio" | "did_not_start" | "not_approved";

/** One stored listing: the description it lists and its result (tool names only when `listed`). */
export interface McpToolList extends PackEntryRef {
  readonly status: McpToolListStatus;
  readonly tools: readonly string[];
}

/** What the listing needs of a started server: its tools' names and its stop (startPackMcpServer, injected). */
export type StartMcpServer = (server: PackMcpServer, opts: { cwd?: string }) => Promise<{ readonly tools: readonly { readonly name: string }[]; close(): Promise<void> }>;

/** A `running` row not finished in this long was left by a stopped worker: another may claim it. */
export const MCP_LIST_STALE_MS = 10 * 60_000;

/** Imported by `factory plugins import` or the dashboard's Import: its descriptor's `source` is claude or codex. */
const isImported = (e: Pick<StoredEntry, "descriptor">): boolean => (IMPORT_SOURCES as readonly unknown[]).includes(e.descriptor.source);

/** The current description of the imported MCP server `name` when it is approved; else null. Reads only. */
async function approvedImported(db: SqlDriver, name: string): Promise<StoredEntry | null> {
  const entry = await new PackEntriesStore(db, () => "").current("mcp_server", name);
  if (entry === null || !isImported(entry)) return null;
  return (await new PackApprovalsStore(db, () => "").approved(entry)) ? entry : null;
}

/** Every imported MCP server whose current description is approved, by name. Reads only. */
export async function approvedImportedServers(db: SqlDriver): Promise<StoredEntry[]> {
  const out: StoredEntry[] = [];
  for (const r of await db.all("SELECT DISTINCT name FROM ext_packs_entries WHERE kind = 'mcp_server' ORDER BY name")) {
    const entry = await approvedImported(db, String(r.name));
    if (entry) out.push(entry);
  }
  return out;
}

const listId = (r: PackEntryRef): string => `ml_${createHash("sha256").update(`${r.name}\n${r.description_hash}`).digest("hex").slice(0, 32)}`;

export class McpToolListsStore {
  constructor(
    private readonly db: SqlDriver,
    /** The change's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /**
   * Asks a worker to list `ref`'s tools as `user_id`: a new `requested` row, or a `not_approved` one asked again
   * (the description was approved again since). False when a row already holds or awaits a result.
   */
  async request(ref: PackEntryRef, user_id: string): Promise<boolean> {
    const at = this.now();
    if (await insertOrSkip(
      this.db,
      "ext_mcp_tool_lists (id, name, description_hash, status, tools, requested_by, claimed_by, created_at, updated_at) VALUES (?, ?, ?, 'requested', NULL, ?, NULL, ?, ?)",
      [listId(ref), ref.name, ref.description_hash, user_id, at, at],
    )) return true;
    const again = await this.db.run(
      "UPDATE ext_mcp_tool_lists SET status = 'requested', requested_by = ?, claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'not_approved'",
      [user_id, at, listId(ref)],
    );
    return again === 1;
  }

  /** Every stored listing. */
  async all(): Promise<McpToolList[]> {
    const rows = await this.db.all("SELECT name, description_hash, status, tools FROM ext_mcp_tool_lists ORDER BY name, description_hash");
    return rows.map((r) => ({
      kind: "mcp_server",
      name: String(r.name),
      description_hash: String(r.description_hash),
      status: String(r.status) as McpToolListStatus,
      tools: r.tools === null || r.tools === undefined ? [] : (JSON.parse(String(r.tools)) as string[]),
    }));
  }

  /**
   * Claims one requested row (or one left `running` past MCP_LIST_STALE_MS) for `by`: a conditional update from the
   * row's read state, so of two workers only one wins it. Null when none is left.
   */
  async claim(by: string): Promise<(PackEntryRef & { readonly id: string }) | null> {
    const at = this.now();
    const stale = new Date(Date.parse(at) - MCP_LIST_STALE_MS).toISOString();
    const rows = await this.db.all(
      "SELECT id, name, description_hash, status, updated_at FROM ext_mcp_tool_lists WHERE status = 'requested' OR (status = 'running' AND updated_at < ?) ORDER BY created_at, id",
      [stale],
    );
    for (const r of rows) {
      const won = await this.db.run(
        "UPDATE ext_mcp_tool_lists SET status = 'running', claimed_by = ?, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?",
        [by, at, String(r.id), String(r.status), String(r.updated_at)],
      );
      if (won === 1) return { id: String(r.id), kind: "mcp_server", name: String(r.name), description_hash: String(r.description_hash) };
    }
    return null;
  }

  /** Ends a row `by` holds; a row another worker took over is left to it. */
  async finish(id: string, by: string, status: Exclude<McpToolListStatus, "requested" | "running">, tools: readonly string[] | null): Promise<void> {
    await this.db.run(
      "UPDATE ext_mcp_tool_lists SET status = ?, tools = ?, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?",
      [status, tools === null ? null : JSON.stringify(tools), this.now(), id, by],
    );
  }
}

/** The UI's side: one request per approved imported server with no row for its current description. Starts nothing. */
export async function requestMcpToolLists(db: SqlDriver, now: () => string, user_id: string): Promise<void> {
  const lists = new McpToolListsStore(db, now);
  for (const entry of await approvedImportedServers(db)) await lists.request(entry, user_id);
}

/** One claimed row's result: the approval read again, then the server started, listed and stopped. */
async function listOne(o: { db: SqlDriver; start: StartMcpServer }, ref: PackEntryRef): Promise<{ status: Exclude<McpToolListStatus, "requested" | "running">; tools: string[] | null }> {
  const entry = await approvedImported(o.db, ref.name);
  if (entry === null || entry.description_hash !== ref.description_hash) return { status: "not_approved", tools: null };
  const server = packMcpServer(entry);
  if (server === null) return { status: "not_stdio", tools: null };
  let running: Awaited<ReturnType<StartMcpServer>>;
  try {
    running = await o.start(server, { cwd: tmpdir() });
  } catch {
    // The error text can carry whatever the server printed: it is neither stored nor shown.
    return { status: "did_not_start", tools: null };
  }
  try {
    return { status: "listed", tools: running.tools.map((t) => t.name) };
  } finally {
    await running.close();
  }
}

/**
 * The worker's side (injected from compose): claims each requested row as `by` and lists it. Its only store writes
 * are its own `ext_mcp_tool_lists` rows.
 */
export async function listRequestedMcpTools(o: { db: SqlDriver; now: () => string; by: string; start: StartMcpServer }): Promise<void> {
  const lists = new McpToolListsStore(o.db, o.now);
  for (let row = await lists.claim(o.by); row !== null; row = await lists.claim(o.by)) {
    const r = await listOne(o, row);
    await lists.finish(row.id, o.by, r.status, r.tools);
  }
}

/** Owner answer 1: each imported MCP server among a run's granted ones is refused as `not_started`. Reads only. */
export async function importedMcpRefusals(db: SqlDriver, servers: readonly PackMcpServer[]): Promise<PackRefusal[]> {
  const entries = new PackEntriesStore(db, () => "");
  const out: PackRefusal[] = [];
  for (const s of servers) {
    const entry = await entries.current("mcp_server", s.name);
    if (entry !== null && isImported(entry)) out.push({ grant: packGrantName("mcp_server", s.name), reason: "not_started" });
  }
  return out;
}
