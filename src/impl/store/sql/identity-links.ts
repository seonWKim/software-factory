// Identity links (design 2026-11-01) and the one owner (issue #577), kept out of sql-factory-store.ts so that file
// stays within its line budget. Link codes are stored only as a hash.

import { createHash } from "node:crypto";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { LinkedAccount } from "../../../interfaces/auth-provider.js";
import type { OwnerDecision, RedeemLinkResult } from "../../../interfaces/factory-store.js";
import { LINK_CODE_MAX_FAILURES, LINK_CODE_TTL_MS } from "../../../interfaces/factory-store.js";
import * as owner from "../../../identity/index.js";
import type { SqlDriver } from "../../../state/index.js";
import type { StoreTime } from "./store-steps.js";

export async function resolveLink(db: SqlDriver, provider: LinkedAccount["provider"], subject: string): Promise<UserId | null> {
  const [row] = await db.all("SELECT user_id FROM identity_user_links WHERE provider = ? AND subject = ?", [provider, subject]);
  return row ? (String(row.user_id) as UserId) : null;
}

export async function listLinks(db: SqlDriver, user_id: UserId): Promise<LinkedAccount[]> {
  const rows = await db.all(
    `SELECT provider, subject FROM identity_user_links WHERE user_id = ? ORDER BY created_at, ${db.dialect.seq}`,
    [user_id],
  );
  return rows.map((r) => ({ provider: String(r.provider) as LinkedAccount["provider"], subject: String(r.subject) }));
}

export async function createLinkCode(db: SqlDriver, time: StoreTime, user_id: UserId, code: string): Promise<{ expires_at: Timestamp }> {
  const expires_at = time.after(LINK_CODE_TTL_MS);
  await db.transaction((tx) =>
    tx.run("INSERT INTO identity_link_codes (code_hash, user_id, expires_at, failures, created_at) VALUES (?, ?, ?, 0, ?)", [
      hashCode(code), user_id, expires_at, time.now(),
    ]),
  );
  return { expires_at };
}

export async function redeemLinkCode(db: SqlDriver, time: StoreTime, code: string, account: LinkedAccount): Promise<RedeemLinkResult> {
  const now = time.now();
  return db.transaction(async (tx): Promise<RedeemLinkResult> => {
    const [row] = await tx.all(`SELECT * FROM identity_link_codes WHERE code_hash = ?`, [hashCode(code)]);
    const user_id = row ? (String(row.user_id) as UserId) : null;
    if (row && row.used_at !== null && row.used_provider === account.provider && row.used_subject === account.subject) {
      return { ok: true, user_id: user_id! };
    }
    const reason = !row ? "invalid" : row.used_at !== null ? "used" : String(row.expires_at) <= now ? "expired"
      : Number(row.failures) >= LINK_CODE_MAX_FAILURES ? "locked" : null;
    if (reason !== null) {
      // A failed attempt counts against every live code, so guessing cannot outlast the lock.
      await tx.run("UPDATE identity_link_codes SET failures = failures + 1 WHERE used_at IS NULL AND expires_at > ?", [now]);
      return { ok: false, reason };
    }
    const [linked] = await tx.all("SELECT user_id FROM identity_user_links WHERE provider = ? AND subject = ?", [account.provider, account.subject]);
    if (linked && linked.user_id !== user_id) return { ok: false, reason: "already_linked" };
    if (!linked) {
      await tx.run("INSERT INTO identity_user_links (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)", [
        account.provider, account.subject, user_id, now,
      ]);
    }
    await tx.run("UPDATE identity_link_codes SET used_at = ?, used_provider = ?, used_subject = ? WHERE code_hash = ?", [
      now, account.provider, account.subject, row!.code_hash as string,
    ]);
    return { ok: true, user_id: user_id! };
  });
}

// The one owner (issue #577)

export async function getOwner(db: SqlDriver): Promise<UserId | null> {
  return (await owner.readOwner(db)) as UserId | null;
}

export async function claimOwner(db: SqlDriver, time: StoreTime, user_id: UserId): Promise<UserId> {
  return (await owner.claimOwner(db, user_id, time.now())) as UserId;
}

export async function recordOwnerDecision(db: SqlDriver, time: StoreTime, d: OwnerDecision): Promise<void> {
  await owner.recordOwnerDecision(db, d, time.now());
}

/** Link codes are stored only as this hash (design 2026-11-01). */
function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
