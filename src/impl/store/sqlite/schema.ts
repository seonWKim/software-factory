// Append-only list. Never edit a migration that has shipped; add a new one.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE work_items (
    id              TEXT PRIMARY KEY,
    version         INTEGER NOT NULL,
    source_type     TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    source_link     TEXT NOT NULL,
    requester_id    TEXT NOT NULL,
    project         TEXT NOT NULL,
    problem         TEXT NOT NULL,
    resources       TEXT NOT NULL,
    done_criteria   TEXT,
    desired_output  TEXT,
    scope           TEXT,
    allowed_paths   TEXT NOT NULL,
    tier            INTEGER,
    stage           TEXT NOT NULL,
    blocked_on      TEXT NOT NULL,
    blocked_reason  TEXT,
    close_reason    TEXT,
    loop_count      INTEGER NOT NULL,
    restart_count   INTEGER NOT NULL,
    token_cost      INTEGER NOT NULL,
    pr_number       INTEGER,
    merge_sha       TEXT,
    fixes_pr        INTEGER,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (source_type, source_id)
  );

  CREATE TABLE state_changes (
    id            TEXT PRIMARY KEY,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    version       INTEGER NOT NULL,
    at            TEXT NOT NULL,
    actor         TEXT NOT NULL,
    reason        TEXT NOT NULL,
    changes       TEXT NOT NULL,
    UNIQUE (work_item_id, version)
  );

  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    work_item_id      TEXT NOT NULL REFERENCES work_items(id),
    kind              TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL UNIQUE,
    status            TEXT NOT NULL,
    attempt           INTEGER NOT NULL,
    lease_owner       TEXT,
    lease_token       INTEGER NOT NULL,
    lease_expires_at  TEXT,
    outcome           TEXT,
    acknowledged_at   TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX runs_claim ON runs (status, kind, created_at);
  CREATE INDEX runs_work_item ON runs (work_item_id);

  CREATE TABLE handoffs (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(id),
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    commit_sha    TEXT NOT NULL,
    worked_on     TEXT NOT NULL,
    next_steps    TEXT NOT NULL,
    at            TEXT NOT NULL,
    UNIQUE (run_id, commit_sha)
  );

  CREATE TABLE cursors (
    name   TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  // 2: revert and fix-forward tracking (design §6). Old rows keep detail NULL.
  `
  ALTER TABLE state_changes ADD COLUMN detail TEXT;
  CREATE INDEX work_items_pr ON work_items (project, pr_number);
  CREATE INDEX work_items_merge_sha ON work_items (merge_sha);
  `,
];
