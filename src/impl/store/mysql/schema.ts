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
  // 2: revert and fix-forward tracking (design §6). Old rows keep detail NULL.
  [
    "ALTER TABLE state_changes ADD COLUMN detail MEDIUMTEXT NULL",
    "CREATE INDEX work_items_pr ON work_items (project, pr_number)",
    "CREATE INDEX work_items_merge_sha ON work_items (merge_sha)",
  ],
  // 3: read-only status page (design §9). Old rows keep title, started_at and finished_at NULL.
  [
    "ALTER TABLE work_items ADD COLUMN title TEXT NULL",
    "ALTER TABLE runs ADD COLUMN started_at CHAR(24) NULL",
    "ALTER TABLE runs ADD COLUMN finished_at CHAR(24) NULL",
    "CREATE INDEX work_items_stage ON work_items (stage, updated_at)",
    "CREATE INDEX runs_finished ON runs (finished_at)",
  ],
  // 4: automatic retries (design §5 Restarts). Old rows keep not_before NULL (claimable at once).
  [
    "ALTER TABLE runs ADD COLUMN not_before CHAR(24) NULL",
    `CREATE TABLE claim_pauses (
      name       VARCHAR(64) NOT NULL PRIMARY KEY,
      resume_at  CHAR(24) NOT NULL
    ) ${TABLE}`,
  ],
  // 5: human verdicts (design §4). One row per `/verdict` comment, linked to its state_changes row.
  [
    `CREATE TABLE verdicts (
      seq              BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id               VARCHAR(64) NOT NULL PRIMARY KEY,
      work_item_id     VARCHAR(64) NOT NULL,
      state_change_id  VARCHAR(64) NOT NULL,
      verdict          VARCHAR(16) NOT NULL,
      severity         VARCHAR(16) NOT NULL,
      reason           MEDIUMTEXT,
      comment_id       VARCHAR(64) NOT NULL,
      target           VARCHAR(16) NOT NULL,
      at               CHAR(24) NOT NULL,
      UNIQUE KEY verdicts_comment (comment_id),
      KEY verdicts_work_item (work_item_id, at),
      FOREIGN KEY (work_item_id) REFERENCES work_items (id),
      FOREIGN KEY (state_change_id) REFERENCES state_changes (id)
    ) ${TABLE}`,
  ],
  // 6: spec revisions (design §4, gate commands). Old rows keep issue_text and spec_feedback NULL.
  [
    "ALTER TABLE work_items ADD COLUMN issue_text MEDIUMTEXT NULL",
    "ALTER TABLE work_items ADD COLUMN revision_count INT NOT NULL DEFAULT 0",
    "ALTER TABLE work_items ADD COLUMN spec_feedback MEDIUMTEXT NULL",
  ],
  // 7: token-budget checkpoints (design §6). One row per checkpoint; the held run waits here, not in runs.
  [
    `CREATE TABLE budget_checkpoints (
      seq                  BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id                   VARCHAR(64) NOT NULL PRIMARY KEY,
      work_item_id         VARCHAR(64) NOT NULL,
      tier                 TINYINT NOT NULL,
      tokens_spent         BIGINT NOT NULL,
      budget               BIGINT NOT NULL,
      suggested_budget     BIGINT NOT NULL,
      answer               VARCHAR(32) NOT NULL,
      granted_budget       BIGINT,
      held_run_kind        VARCHAR(16) NOT NULL,
      held_run_key         VARCHAR(255) NOT NULL,
      held_run_not_before  CHAR(24),
      outcome              VARCHAR(16),
      created_at           CHAR(24) NOT NULL,
      answered_at          CHAR(24),
      KEY budget_checkpoints_work_item (work_item_id, created_at),
      FOREIGN KEY (work_item_id) REFERENCES work_items (id)
    ) ${TABLE}`,
    "CREATE INDEX work_items_tier ON work_items (project, tier, stage)",
  ],
];
