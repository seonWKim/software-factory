// The audit of local users (identity_local_user_changes, design 08-permissions, issue #445). The store writes one
// row inside the transaction that adds, changes or removes an identity_local_users row, so `factory users` and the
// dashboard's Users page write the same row. A refused write, or a set to the role a user already has, writes none.

import type { SqlExecutor } from "../../state/index.js";

export interface LocalUserChange {
  readonly user_id: string;
  readonly action: "add" | "change" | "remove";
  /** Null for an add. */
  readonly old_role: string | null;
  /** Null for a remove. */
  readonly new_role: string | null;
  /** The user ID that made the change. */
  readonly actor: string;
  readonly at: string;
}

/** Writes one change row with the caller's executor (its open transaction). */
export async function recordLocalUserChange(tx: SqlExecutor, c: LocalUserChange): Promise<void> {
  await tx.run(
    "INSERT INTO identity_local_user_changes (user_id, action, old_role, new_role, actor, at) VALUES (?, ?, ?, ?, ?, ?)",
    [c.user_id, c.action, c.old_role, c.new_role, c.actor, c.at],
  );
}
