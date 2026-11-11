// The grant check of pack tools and MCP servers (design 11-packs, issue #589), run where the worker builds a run's
// grants. A run kind's `tool_grants` may name a pack entry as `pack:<kind>:<name>` (PACK_GRANT, src/core/config.ts).
// Such an entry reaches a run only when both hold: the run kind grants it, and its current description is approved
// (an approval row for that description_hash, or the default-off `packs.auto_approve_read_only` for a read-only
// entry with no credential). An entry the run kind does not grant is never listed. A tool that passes both checks
// joins the run's broker tools: the pack tool broker (src/impl/broker/pack-tool-broker.ts) serves it and checks the
// approval again on every call (issue #592). No MCP server starts yet: one that passes both checks is refused, as
// `not_started`, and the run fails before its agent starts.

import { PACK_GRANT } from "../core/config.js";
import type { SqlDriver } from "../state/index.js";
import { PackApprovalsStore } from "./pack-approvals.store.js";
import { PackEntriesStore, type PackEntryKind, type StoredEntry } from "./pack-entries.store.js";

/** The run's error code when it is granted a pack entry it cannot have. */
export const PACK_TOOL_REFUSED = "pack_tool_refused";

/** `no_entry`: nothing is stored under the name. `not_approved`: its current description is not approved. `not_started`: an MCP server passes both checks; none starts yet. */
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
 * A run kind's grants split in two: the broker tools (with each approved pack tool) and a refusal for each other pack
 * entry it names.
 * Reads the store only (no time, no write).
 */
export async function checkPackGrants(
  db: SqlDriver,
  grants: readonly string[],
  autoApproveReadOnly: boolean,
): Promise<{ broker: string[]; refused: PackRefusal[] }> {
  const broker: string[] = [];
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
    else refused.push({ grant, reason: "not_started" });
  }
  return { broker, refused };
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
