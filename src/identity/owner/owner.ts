// The one owner (design 08-permissions, One owner; issue #577): the store's identity_owner table holds at most one
// row, the owner's user ID, claimed by the first local identity that writes. Each owner-check decision writes one
// authz_audit row with no passport (`none`), as Identity's own decisions write theirs. Plain SQL on the caller's
// executor.

import type { SqlExecutor } from "../../state/index.js";
import { resourceText } from "../passport/store.js";
import type { Action, ResourceRef } from "../passport/types.js";

export const OWNER_TABLE = "identity_owner";

/** The passport_id of a decision made with no passport: a person's command (authz_audit's column is NOT NULL). */
export const NO_PASSPORT = "none";

/** The owner's user ID, or null while no one has claimed it. */
export async function readOwner(db: SqlExecutor): Promise<string | null> {
  const [row] = await db.all(`SELECT user_id FROM ${OWNER_TABLE} WHERE slot = 1`);
  return row ? String(row.user_id) : null;
}

/**
 * Makes `user_id` the owner when no one is, and returns the owner (the existing one, or `user_id`). At most one,
 * whatever replicas or terminals race: the one slot is the primary key, so a second claim changes nothing.
 */
export async function claimOwner(db: SqlExecutor, user_id: string, at: string): Promise<string> {
  await db.run(`INSERT INTO ${OWNER_TABLE} (slot, user_id, claimed_at) VALUES (1, ?, ?) ON CONFLICT DO NOTHING`, [user_id, at]);
  return (await readOwner(db))!;
}

/** What an owner-check decision was about: the AuthProvider's resource. */
export interface OwnerResource {
  readonly kind: "project" | "work_item" | "tool";
  readonly id: string;
}

export interface OwnerDecision {
  readonly principal: string;
  readonly action: Action;
  /** Absent: a check with no resource (the owner may act on every one). */
  readonly resource?: OwnerResource;
  readonly allow: boolean;
  /** `allowed`, or the refusal reason. */
  readonly reason: string;
}

/** Writes the decision's one authz_audit row, with passport `none`. */
export async function recordOwnerDecision(db: SqlExecutor, d: OwnerDecision, at: string): Promise<void> {
  await db.run(
    "INSERT INTO authz_audit (passport_id, principal, action, resource, decision, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [NO_PASSPORT, d.principal, d.action, resourceText(resourceRef(d.resource)), d.allow ? "allow" : "deny", d.reason, at],
  );
}

function resourceRef(r: OwnerResource | undefined): ResourceRef {
  if (r === undefined) return { project: null };
  return r.kind === "work_item" ? { project: null, item: r.id } : r.kind === "project" ? { project: r.id } : { project: null, tool: r.id };
}
