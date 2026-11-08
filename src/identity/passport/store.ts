// Identity's tables (RFC 0015 §6.3): identity_passports (one row per link, never the token), the deny list
// identity_revocations, and authz_audit (every decision). Plain SQL that runs on SQLite and MySQL.

import type { SqlExecutor } from "../../state/index.js";
import { canonicalRestrictions } from "./restrictions.js";
import type { Link } from "./token.js";
import type { Action, LinkedAccount, Origin, PassportKind, Provider, ResourceRef, Restrictions } from "./types.js";

export interface PassportRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly principal: string;
  readonly provider: Provider;
  readonly origin: Origin;
  readonly kind: PassportKind;
  readonly restrictions: Restrictions;
  readonly key_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly token_hash: string;
}

export interface AuditEntry {
  readonly passport_id: string;
  readonly principal: string;
  readonly action: Action;
  readonly resource: ResourceRef;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly at: string;
}

/** A resource as stable text for the audit: keys in a fixed order, absent ones left out. */
export function resourceText(r: ResourceRef): string {
  const out: Record<string, unknown> = { project: r.project };
  for (const k of ["item", "run", "branch", "paths", "tool", "audience"] as const) if (r[k] !== undefined) out[k] = r[k];
  return JSON.stringify(out);
}

export class PassportStore {
  constructor(private readonly db: SqlExecutor) {}

  async insert(link: Link, token_hash: string): Promise<void> {
    await this.db.run(
      `INSERT INTO identity_passports (id, parent_id, principal, provider, origin, kind, restrictions, token_hash, key_id, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        link.id,
        link.parent_id,
        link.principal,
        link.provider,
        link.origin,
        link.kind,
        JSON.stringify(canonicalRestrictions(link.restrictions)),
        token_hash,
        link.key_id,
        link.issued_at,
        link.expires_at,
      ],
    );
  }

  async get(id: string): Promise<PassportRow | null> {
    const [r] = await this.db.all(
      "SELECT id, parent_id, principal, provider, origin, kind, restrictions, token_hash, key_id, issued_at, expires_at FROM identity_passports WHERE id = ?",
      [id],
    );
    if (!r) return null;
    return {
      id: String(r.id),
      parent_id: r.parent_id === null ? null : String(r.parent_id),
      principal: String(r.principal),
      provider: String(r.provider) as Provider,
      origin: String(r.origin) as Origin,
      kind: String(r.kind) as PassportKind,
      restrictions: JSON.parse(String(r.restrictions)) as Restrictions,
      key_id: String(r.key_id),
      issued_at: String(r.issued_at),
      expires_at: String(r.expires_at),
      token_hash: String(r.token_hash),
    };
  }

  /** The chain of `id`, root first; null when any link is missing. Bounded by `maxDepth` against a cycle. */
  async chain(id: string, maxDepth = 16): Promise<PassportRow[] | null> {
    const out: PassportRow[] = [];
    let next: string | null = id;
    while (next !== null) {
      if (out.length >= maxDepth) return null;
      const row = await this.get(next);
      if (!row) return null;
      out.unshift(row);
      next = row.parent_id;
    }
    return out;
  }

  /** Records a revocation; a second one of the same passport changes nothing. */
  async revoke(passport_id: string, revoked_by: string, reason: string, revoked_at: string, expires_at: string): Promise<void> {
    const [has] = await this.db.all("SELECT 1 AS x FROM identity_revocations WHERE passport_id = ?", [passport_id]);
    if (has) return;
    await this.db.run(
      "INSERT INTO identity_revocations (passport_id, revoked_by, reason, revoked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [passport_id, revoked_by, reason, revoked_at, expires_at],
    );
  }

  /** Revocations still in force at `now`; ones past their passport's expiry are pruned first. */
  async liveRevocations(now: string): Promise<Set<string>> {
    await this.db.run("DELETE FROM identity_revocations WHERE expires_at <= ?", [now]);
    return new Set((await this.db.all("SELECT passport_id FROM identity_revocations")).map((r) => String(r.passport_id)));
  }

  async isRevoked(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    const rows = await this.db.all(`SELECT 1 AS x FROM identity_revocations WHERE passport_id IN (${ids.map(() => "?").join(", ")})`, ids);
    return rows.length > 0;
  }

  async audit(e: AuditEntry): Promise<void> {
    await this.db.run(
      "INSERT INTO authz_audit (passport_id, principal, action, resource, decision, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [e.passport_id, e.principal, e.action, resourceText(e.resource), e.decision, e.reason, e.at],
    );
  }

  /** The accounts linked to a user (identity_user_links), for grant sources. */
  async accounts(user_id: string): Promise<LinkedAccount[]> {
    const rows = await this.db.all("SELECT provider, subject FROM identity_user_links WHERE user_id = ? ORDER BY provider, subject", [user_id]);
    return rows.map((r) => ({ provider: String(r.provider), subject: String(r.subject) }));
  }
}
