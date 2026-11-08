// RFC 0015 M9: passports (one row per chain link; the token itself is never stored, only its hash), the
// revocation deny list, and the audit of every authorize() decision. Additive: new tables only, safe to rerun.
// Principals are user ids or service names, never display names.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
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

const TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

// Indexes inline, so each statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS identity_passports (
    id            VARCHAR(191) NOT NULL PRIMARY KEY,
    parent_id     VARCHAR(191) NULL,
    principal     VARCHAR(191) NOT NULL,
    provider      VARCHAR(32) NOT NULL,
    origin        VARCHAR(32) NOT NULL,
    kind          VARCHAR(16) NOT NULL,
    restrictions  MEDIUMTEXT NOT NULL,
    token_hash    CHAR(64) NOT NULL,
    key_id        VARCHAR(64) NOT NULL,
    issued_at     CHAR(24) NOT NULL,
    expires_at    CHAR(24) NOT NULL,
    KEY identity_passports_parent (parent_id),
    KEY identity_passports_expiry (expires_at)
  ) ${TABLE_OPTIONS}`,
  `CREATE TABLE IF NOT EXISTS identity_revocations (
    passport_id  VARCHAR(191) NOT NULL PRIMARY KEY,
    revoked_by   VARCHAR(191) NOT NULL,
    reason       VARCHAR(255) NOT NULL,
    revoked_at   CHAR(24) NOT NULL,
    expires_at   CHAR(24) NOT NULL
  ) ${TABLE_OPTIONS}`,
  `CREATE TABLE IF NOT EXISTS authz_audit (
    seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    passport_id  VARCHAR(191) NOT NULL,
    principal    VARCHAR(191) NOT NULL,
    action       VARCHAR(64) NOT NULL,
    resource     TEXT NOT NULL,
    decision     VARCHAR(8) NOT NULL,
    reason       VARCHAR(255) NOT NULL,
    at           CHAR(24) NOT NULL,
    KEY authz_audit_principal (principal, at),
    KEY authz_audit_at (at)
  ) ${TABLE_OPTIONS}`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
