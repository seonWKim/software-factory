// The grant check of pack tools and MCP servers (design 11-packs, issue #589), run where the worker builds a run's
// grants. A run kind's `tool_grants` may name a pack entry as `pack:<kind>:<name>` (PACK_GRANT, src/core/config.ts).
// Such an entry reaches a run only when both hold: the run kind grants it, and its current description is approved
// (an approval row for that description_hash, or the default-off `packs.auto_approve_read_only` for a read-only
// entry with no credential). An entry the run kind does not grant is never listed. A tool that passes both checks
// joins the run's broker tools: the pack tool broker (src/impl/broker/pack-tool-broker.ts) serves it and checks the
// approval again on every call (issue #592). An MCP server that passes both checks reaches the run as its
// descriptor's `command` and `args` (issue #596), when it is a stdio server with no credential; any other is refused,
// as `not_started`, and the run fails before its agent starts.

import { PACK_GRANT } from "../core/config.js";
import type { PackMcpServer } from "../interfaces/agent-runner.js";
import type { SqlDriver } from "../state/index.js";
import { PackApprovalsStore } from "./pack-approvals.store.js";
import { PackEntriesStore, type PackEntryKind, type StoredEntry } from "./pack-entries.store.js";

/** The run's error code when it is granted a pack entry it cannot have. */
export const PACK_TOOL_REFUSED = "pack_tool_refused";

/**
 * `no_entry`: nothing is stored under the name. `not_approved`: its current description is not approved.
 * `not_started`: an approved MCP server the factory does not start: it names a credential, is not a stdio server
 * with a `command`, or the run's runner cannot run MCP servers.
 */
export type PackRefusalReason = "no_entry" | "not_approved" | "not_started";

export interface PackRefusal {
  readonly grant: string;
  readonly reason: PackRefusalReason;
}

/** The auto-approve rule: only with the setting on, and only a read-only entry that reads no credential. */
export function autoApproved(entry: Pick<StoredEntry, "read_only" | "credential_name">, autoApproveReadOnly: boolean): boolean {
  return autoApproveReadOnly && entry.read_only && entry.credential_name === null;
}

/**
 * The MCP server an approved descriptor starts: stdio only (`type` absent or `"stdio"`), a non-empty `command`
 * string and `args` absent or strings; its `env` is never read (the server starts with an empty one). Null for any
 * other descriptor, and for one that names a credential: no server is handed a factory secret.
 */
export function packMcpServer(entry: Pick<StoredEntry, "name" | "credential_name" | "descriptor">): PackMcpServer | null {
  const { type, command, args = [] } = entry.descriptor;
  if (entry.credential_name !== null || (type !== undefined && type !== "stdio")) return null;
  if (typeof command !== "string" || command.trim() === "") return null;
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) return null;
  return { name: entry.name, command, args };
}

/**
 * A run kind's grants split in three: the broker tools (with each approved pack tool), each approved MCP server
 * the factory starts, and a refusal for each other pack entry it names. `runsMcpServers` false (the run's runner
 * cannot run them): every approved MCP server is refused too.
 * Reads the store only (no time, no write).
 */
export async function checkPackGrants(
  db: SqlDriver,
  grants: readonly string[],
  autoApproveReadOnly: boolean,
  runsMcpServers = true,
): Promise<{ broker: string[]; mcp_servers: PackMcpServer[]; refused: PackRefusal[] }> {
  const broker: string[] = [];
  const mcp_servers: PackMcpServer[] = [];
  const refused: PackRefusal[] = [];
  for (const grant of grants) {
    const m = PACK_GRANT.exec(grant);
    if (!m) {
      broker.push(grant);
      continue;
    }
    const kind = m[1] as PackEntryKind;
    const found = await approvedEntry(db, kind, m[2]!, autoApproveReadOnly);
    if (typeof found === "string") refused.push({ grant, reason: found });
    else if (kind === "tool") broker.push(grant);
    else {
      const server = packMcpServer(found);
      if (server && runsMcpServers) mcp_servers.push(server);
      else refused.push({ grant, reason: "not_started" });
    }
  }
  return { broker, mcp_servers, refused };
}

/**
 * The approval check of one entry: its current description, when it is approved; else why not. Reads the store
 * only (no time, no write), so the grant check and the pack tool broker can each run it any number of times.
 */
export async function approvedEntry(
  db: SqlDriver,
  kind: PackEntryKind,
  name: string,
  autoApproveReadOnly: boolean,
): Promise<StoredEntry | "no_entry" | "not_approved"> {
  const entry = await new PackEntriesStore(db, () => "").current(kind, name);
  if (entry === null) return "no_entry";
  if (autoApproved(entry, autoApproveReadOnly)) return entry;
  return (await new PackApprovalsStore(db, () => "").approved(entry)) ? entry : "not_approved";
}

/** The failed run's message: each refused grant with its reason. */
export function packRefusalMessage(refused: readonly PackRefusal[]): string {
  return `pack tools refused: ${refused.map((r) => `${r.grant} ${r.reason}`).join(", ")}`;
}
