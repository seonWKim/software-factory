// Append-only list. Never edit a migration that has shipped; add a new one.
// Each migration is a list of statements (the driver runs one statement per query).
// Same columns as the SQLite schema, plus `seq` for stable insertion order (SQLite uses rowid).
// utf8mb4_bin: ids, ISO timestamps and cursor values compare byte-for-byte, as in SQLite.

const TABLE = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE work_items (
      seq             BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id              VARCHAR(64) NOT NULL PRIMARY KEY,
      version         INT NOT NULL,
      source_type     VARCHAR(32) NOT NULL,
      source_id       VARCHAR(255) NOT NULL,
      source_link     TEXT NOT NULL,
      requester_id    VARCHAR(128) NOT NULL,
      project         VARCHAR(255) NOT NULL,
      problem         MEDIUMTEXT NOT NULL,
      resources       MEDIUMTEXT NOT NULL,
      done_criteria   MEDIUMTEXT,
      desired_output  MEDIUMTEXT,
      scope           MEDIUMTEXT,
      allowed_paths   MEDIUMTEXT NOT NULL,
      tier            TINYINT,
      stage           VARCHAR(16) NOT NULL,
      blocked_on      VARCHAR(16) NOT NULL,
      blocked_reason  TEXT,
      close_reason    VARCHAR(32),
      loop_count      INT NOT NULL,
      restart_count   INT NOT NULL,
      token_cost      BIGINT NOT NULL,
      pr_number       INT,
      merge_sha       VARCHAR(64),
      fixes_pr        INT,
      created_at      CHAR(24) NOT NULL,
      updated_at      CHAR(24) NOT NULL,
      UNIQUE KEY work_items_source (source_type, source_id)
    ) ${TABLE}`,
    `CREATE TABLE state_changes (
      id            VARCHAR(64) NOT NULL PRIMARY KEY,
      work_item_id  VARCHAR(64) NOT NULL,
      version       INT NOT NULL,
      at            CHAR(24) NOT NULL,
      actor         TEXT NOT NULL,
      reason        VARCHAR(64) NOT NULL,
      changes       MEDIUMTEXT NOT NULL,
      UNIQUE KEY state_changes_version (work_item_id, version),
      FOREIGN KEY (work_item_id) REFERENCES work_items (id)
    ) ${TABLE}`,
    `CREATE TABLE runs (
      seq               BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id                VARCHAR(64) NOT NULL PRIMARY KEY,
      work_item_id      VARCHAR(64) NOT NULL,
      kind              VARCHAR(16) NOT NULL,
      idempotency_key   VARCHAR(255) NOT NULL UNIQUE,
      status            VARCHAR(16) NOT NULL,
      attempt           INT NOT NULL,
      lease_owner       VARCHAR(255),
      lease_token       BIGINT NOT NULL,
      lease_expires_at  CHAR(24),
      outcome           MEDIUMTEXT,
      acknowledged_at   CHAR(24),
      created_at        CHAR(24) NOT NULL,
      updated_at        CHAR(24) NOT NULL,
      KEY runs_claim (status, kind, created_at, seq),
      KEY runs_work_item (work_item_id),
      FOREIGN KEY (work_item_id) REFERENCES work_items (id)
    ) ${TABLE}`,
    `CREATE TABLE handoffs (
      seq           BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id            VARCHAR(64) NOT NULL PRIMARY KEY,
      run_id        VARCHAR(64) NOT NULL,
      work_item_id  VARCHAR(64) NOT NULL,
      commit_sha    VARCHAR(64) NOT NULL,
      worked_on     MEDIUMTEXT NOT NULL,
      next_steps    MEDIUMTEXT NOT NULL,
      at            CHAR(24) NOT NULL,
      UNIQUE KEY handoffs_commit (run_id, commit_sha),
      FOREIGN KEY (run_id) REFERENCES runs (id),
      FOREIGN KEY (work_item_id) REFERENCES work_items (id)
    ) ${TABLE}`,
    `CREATE TABLE cursors (
      name   VARCHAR(128) NOT NULL PRIMARY KEY,
      value  MEDIUMTEXT NOT NULL
    ) ${TABLE}`,
  ],
];
