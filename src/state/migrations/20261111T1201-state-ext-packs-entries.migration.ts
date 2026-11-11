// Pack tool and MCP server entries (design 11-packs, issue #588): one `ext_packs_entries` row per tool or MCP server
// descriptor `factory pack add` accepted, keyed on (kind, name, description_hash) so adding the same descriptor again
// writes nothing. `descriptor` is the scanned canonical JSON (no secret value: the credential-leak scan refuses one);
// `credential_name` is the name of the environment variable a tool reads, never its value. `status` is `pending` in
// this phase: nothing starts or calls an entry. Additive: a new table only, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_packs_entries";

const SQLITE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    description_hash  TEXT NOT NULL,
    descriptor        TEXT NOT NULL,
    credential_name   TEXT,
    status            TEXT NOT NULL,
    added_by          TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (kind, name, description_hash)
  )`;

const MYSQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id                VARCHAR(191) NOT NULL PRIMARY KEY,
    kind              VARCHAR(16) NOT NULL,
    name              VARCHAR(191) NOT NULL,
    description_hash  CHAR(64) NOT NULL,
    descriptor        MEDIUMTEXT NOT NULL,
    credential_name   VARCHAR(191) NULL,
    status            VARCHAR(16) NOT NULL,
    added_by          VARCHAR(191) NOT NULL,
    created_at        CHAR(24) NOT NULL,
    updated_at        CHAR(24) NOT NULL,
    UNIQUE KEY ext_packs_entries_key (kind, name, description_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(db.dialect === "sqlite" ? SQLITE : MYSQL);
  },
});
