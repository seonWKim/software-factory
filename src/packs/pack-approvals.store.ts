// Approvals of pack tool and MCP server entries (design 11-packs, issue #589). The owner approves or revokes one
// stored description of an entry (kind, name, description_hash) from `factory pack approve|revoke` or the dashboard;
// both ask AuthProvider.authorize for `approve_tool` first (solo: the local owner check; enterprise: the configured
// plugin, audited as any decision). An allowed change writes one `ext_packs_approvals` row with the approver's user
// ID and the description_hash; a refused one writes nothing. The latest row of a key decides: the approval is pinned
// to that description, so a new description of the same name is off until it is approved in turn.

import type { UserId } from "../core/types.js";
import type { AuthProvider } from "../interfaces/auth-provider.js";
import type { SqlExecutor } from "../state/index.js";
import { type PackEntriesStore, type PackEntryKind, type PackEntryRef, PACK_ENTRY_KINDS } from "./pack-entries.store.js";

export type ApprovalAction = "approve" | "revoke";

/** The `tool_grants` and authorize name of an entry: `pack:<kind>:<name>` (PACK_GRANT, src/core/config.ts). */
export const packGrantName = (kind: PackEntryKind, name: string): string => `pack:${kind}:${name}`;

export class PackApprovalsStore {
  constructor(
    private readonly db: SqlExecutor,
    /** The change's time, ISO (the injected Clock). */
    private readonly now: () => string,
  ) {}

  /** Appends one approve or revoke row: the change and its audit at once. */
  async record(ref: PackEntryRef, action: ApprovalAction, user_id: UserId): Promise<void> {
    await this.db.run(
      "INSERT INTO ext_packs_approvals (kind, name, description_hash, action, user_id, at) VALUES (?, ?, ?, ?, ?, ?)",
      [ref.kind, ref.name, ref.description_hash, action, user_id, this.now()],
    );
  }

  /** Whether this exact description is approved: its latest row is an approve. */
  async approved(ref: PackEntryRef): Promise<boolean> {
    const [r] = await this.db.all(
      "SELECT action FROM ext_packs_approvals WHERE kind = ? AND name = ? AND description_hash = ? ORDER BY seq DESC LIMIT 1",
      [ref.kind, ref.name, ref.description_hash],
    );
    return r?.action === "approve";
  }
}

export interface ApprovalRequest {
  readonly action: ApprovalAction;
  readonly kind: string;
  readonly name: string;
  /** A prefix of the description_hash to change (as `pack add` printed it); absent: the current description. */
  readonly hash?: string;
}

/** A refusal is `not_allowed` (the authorize check) or `no_entry` (no stored description matches). */
export type ApprovalResult = { ok: true; ref: PackEntryRef } | { ok: false; refusal: "not_allowed" | "no_entry"; reason: string };

/** Which stored description a request names, or why none. */
async function target(entries: PackEntriesStore, r: ApprovalRequest): Promise<PackEntryRef | string> {
  if (!(PACK_ENTRY_KINDS as readonly string[]).includes(r.kind)) return `kind must be one of ${PACK_ENTRY_KINDS.join(", ")}`;
  const kind = r.kind as PackEntryKind;
  if (r.hash === undefined) return (await entries.current(kind, r.name)) ?? `no ${kind} ${r.name} is stored`;
  const found = (await entries.hashes(kind, r.name)).filter((h) => h.startsWith(r.hash!.toLowerCase()));
  if (found.length === 1) return { kind, name: r.name, description_hash: found[0]! };
  return found.length === 0 ? `no ${kind} ${r.name} has a description_hash starting ${r.hash}` : `${r.hash} names more than one description of ${kind} ${r.name}`;
}

/**
 * Approves or revokes one description of an entry as `user_id`: the authorize check (`approve_tool` on the entry),
 * then the entry, then one row. Every refusal comes before the write.
 */
export async function changeApproval(
  o: { auth: Pick<AuthProvider, "authorize">; entries: PackEntriesStore; approvals: PackApprovalsStore; user_id: UserId },
  r: ApprovalRequest,
): Promise<ApprovalResult> {
  const decision = await o.auth.authorize({ user_id: o.user_id, attributes: {} }, "approve_tool", { kind: "tool", id: packGrantName(r.kind as PackEntryKind, r.name) });
  if (!decision.allow) return { ok: false, refusal: "not_allowed", reason: `${r.action} needs approve_tool: ${decision.reason}` };
  const ref = await target(o.entries, r);
  if (typeof ref === "string") return { ok: false, refusal: "no_entry", reason: ref };
  await o.approvals.record(ref, r.action, o.user_id);
  return { ok: true, ref: { kind: ref.kind, name: ref.name, description_hash: ref.description_hash } };
}

/** The line a change prints: what changed and the description it is pinned to. */
export function approvalLine(r: ApprovalRequest, result: ApprovalResult): string {
  if (!result.ok) return `refused: ${result.reason}`;
  const what = `${result.ref.kind === "tool" ? "tool" : "MCP server"} ${result.ref.name}`;
  return `${r.action === "approve" ? "approved" : "revoked"} ${what} (description_hash ${result.ref.description_hash.slice(0, 12)})`;
}
