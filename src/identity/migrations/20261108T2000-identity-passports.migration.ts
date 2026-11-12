// RFC 0015 M9: passports (one row per chain link; the token itself is never stored, only its hash), the
// revocation deny list, and the audit of every authorize() decision. Additive: new tables only, safe to rerun.
// Principals are user ids or service names, never display names.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS identity_passports (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT,
    principal     TEXT NOT NULL,
    provider      TEXT NOT NULL,
    origin        TEXT NOT NULL,
    kind          TEXT NOT NULL,
    restrictions  TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    key_id        TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS identity_passports_parent ON identity_passports (parent_id)",
  "CREATE INDEX IF NOT EXISTS identity_passports_expiry ON identity_passports (expires_at)",
  `CREATE TABLE IF NOT EXISTS identity_revocations (
    passport_id  TEXT PRIMARY KEY,
    revoked_by   TEXT NOT NULL,
    reason       TEXT NOT NULL,
    revoked_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authz_audit (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    passport_id  TEXT NOT NULL,
    principal    TEXT NOT NULL,
    action       TEXT NOT NULL,
    resource     TEXT NOT NULL,
    decision     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    at           TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS authz_audit_principal ON authz_audit (principal, at)",
  "CREATE INDEX IF NOT EXISTS authz_audit_at ON authz_audit (at)",
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
