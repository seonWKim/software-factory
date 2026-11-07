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
  // 3: read-only status page (design §9). Old rows keep title, started_at and finished_at NULL.
  `
  ALTER TABLE work_items ADD COLUMN title TEXT;
  ALTER TABLE runs ADD COLUMN started_at TEXT;
  ALTER TABLE runs ADD COLUMN finished_at TEXT;
  CREATE INDEX work_items_stage ON work_items (stage, updated_at);
  CREATE INDEX runs_finished ON runs (finished_at);
  `,
  // 4: automatic retries (design §5 Restarts). Old rows keep not_before NULL (claimable at once).
  `
  ALTER TABLE runs ADD COLUMN not_before TEXT;
  CREATE TABLE claim_pauses (
    name       TEXT PRIMARY KEY,
    resume_at  TEXT NOT NULL
  );
  `,
  // 5: human verdicts (design §4). One row per `/verdict` comment, linked to its state_changes row.
  `
  CREATE TABLE verdicts (
    id               TEXT PRIMARY KEY,
    work_item_id     TEXT NOT NULL REFERENCES work_items(id),
    state_change_id  TEXT NOT NULL REFERENCES state_changes(id),
    verdict          TEXT NOT NULL,
    severity         TEXT NOT NULL,
    reason           TEXT,
    comment_id       TEXT NOT NULL UNIQUE,
    target           TEXT NOT NULL,
    at               TEXT NOT NULL
  );
  CREATE INDEX verdicts_work_item ON verdicts (work_item_id, at);
  `,
  // 6: spec revisions (design §4, gate commands). Old rows keep issue_text and spec_feedback NULL.
  `
  ALTER TABLE work_items ADD COLUMN issue_text TEXT;
  ALTER TABLE work_items ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE work_items ADD COLUMN spec_feedback TEXT;
  `,
  // 7: parallel workers (architecture §4). One lock row the claim takes first, so two claimers never both pass
  // the overlap check. SQLite's BEGIN IMMEDIATE already serializes claims; the row keeps both schemas alike.
  `
  CREATE TABLE claim_locks (
    name  TEXT PRIMARY KEY
  );
  INSERT INTO claim_locks (name) VALUES ('claim');
  `,
  // 8: comment links for the status page's Needs you list (design §9). Old rows keep both NULL (link to the issue).
  `
  ALTER TABLE work_items ADD COLUMN spec_comment_url TEXT;
  ALTER TABLE work_items ADD COLUMN failure_comment_url TEXT;
  `,
  // 9: token-budget checkpoints (design §6). One row per checkpoint; the held run waits here, not in runs.
  `
  CREATE TABLE budget_checkpoints (
    id                   TEXT PRIMARY KEY,
    work_item_id         TEXT NOT NULL REFERENCES work_items(id),
    tier                 INTEGER NOT NULL,
    tokens_spent         INTEGER NOT NULL,
    budget               INTEGER NOT NULL,
    suggested_budget     INTEGER NOT NULL,
    answer               TEXT NOT NULL,
    granted_budget       INTEGER,
    held_run_kind        TEXT NOT NULL,
    held_run_key         TEXT NOT NULL,
    held_run_not_before  TEXT,
    outcome              TEXT,
    created_at           TEXT NOT NULL,
    answered_at          TEXT
  );
  CREATE INDEX budget_checkpoints_work_item ON budget_checkpoints (work_item_id, created_at);
  CREATE INDEX work_items_tier ON work_items (project, tier, stage);
  `,
  // 10: stream intake (docs/architecture.md, Intake). Pushed events are stored here before they are acked.
  // AUTOINCREMENT: a seq is never reused, even after cleanup deletes the newest rows, so a cursor never
  // skips an event. One listener lease row per source type.
  `
  CREATE TABLE source_inbox (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type  TEXT NOT NULL,
    dedupe_key   TEXT NOT NULL,
    event        TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    UNIQUE (source_type, dedupe_key)
  );
  CREATE INDEX source_inbox_seq ON source_inbox (source_type, seq);
  CREATE TABLE listener_leases (
    source_type  TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    token        INTEGER NOT NULL,
    expires_at   TEXT NOT NULL
  );
  `,
  // 11: run input, e.g. the notes of a /resolve (design §5 Merge conflict). Old rows keep input NULL.
  `
  ALTER TABLE runs ADD COLUMN input TEXT;
  `,
  // 12: pull requests the factory did not open (design 2026-11-01). Old items are origin 'factory' with no head
  // branch or recorded head. One unreviewed_merges row per PR that merged with no work item.
  `
  ALTER TABLE work_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'factory';
  ALTER TABLE work_items ADD COLUMN head_branch TEXT;
  ALTER TABLE work_items ADD COLUMN last_head_sha TEXT;
  CREATE TABLE unreviewed_merges (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    merge_sha   TEXT NOT NULL,
    merger_id   TEXT,
    at          TEXT NOT NULL,
    UNIQUE (project, pr_number)
  );
  CREATE INDEX unreviewed_merges_at ON unreviewed_merges (at);
  `,
  // 13: split specs (design 2026-11-01, issue #102). A phase's parent item and its place in merge order. Old
  // rows and every item that is not a phase keep both NULL.
  `
  ALTER TABLE work_items ADD COLUMN parent_id TEXT;
  ALTER TABLE work_items ADD COLUMN phase INTEGER;
  CREATE INDEX work_items_parent ON work_items (parent_id, phase);
  `,
  // 14: identity links and one-time link codes (design 2026-11-01, issue #107). Links are keyed by provider and
  // subject only. A code is stored as its SHA-256 hash, never in plain text.
  `
  CREATE TABLE user_links (
    provider    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX user_links_user ON user_links (user_id);
  CREATE TABLE link_codes (
    code_hash      TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    failures       INTEGER NOT NULL DEFAULT 0,
    used_at        TEXT,
    used_provider  TEXT,
    used_subject   TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX link_codes_live ON link_codes (used_at, expires_at);
  `,
  // 15: pause and resume (design §5 Pause, issue #146). A paused run waits in queued with paused_at set; its
  // session and resume point are kept for the next claim. One worker_pauses row per paused worker loop, `*` for
  // every loop. Old rows keep the new run columns NULL.
  `
  ALTER TABLE runs ADD COLUMN paused_at TEXT;
  ALTER TABLE runs ADD COLUMN paused_by TEXT;
  ALTER TABLE runs ADD COLUMN session_id TEXT;
  ALTER TABLE runs ADD COLUMN pause_state TEXT;
  CREATE TABLE worker_pauses (
    worker_id   TEXT PRIMARY KEY,
    paused_by   TEXT NOT NULL,
    paused_at   TEXT NOT NULL
  );
  `,
  // 16: coordination (design §5, 2026-11-03). Triage's files_to_change and a PR's file list on the item (old rows
  // keep both NULL: the cost falls back to allowed_paths). Dependency edges, recorded conflicts per file (one row
  // per file and conflict event, so recording twice counts once), and the latest claim decision per held run.
  `
  ALTER TABLE work_items ADD COLUMN files_to_change TEXT;
  ALTER TABLE work_items ADD COLUMN pr_files TEXT;
  CREATE TABLE dependency_edges (
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    depends_on    TEXT NOT NULL,
    kind          TEXT NOT NULL,
    state         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (work_item_id, depends_on)
  );
  CREATE INDEX dependency_edges_target ON dependency_edges (depends_on);
  CREATE TABLE file_conflicts (
    project_key  TEXT NOT NULL,
    path         TEXT NOT NULL,
    event_key    TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (project_key, path, event_key)
  );
  CREATE TABLE claim_decisions (
    run_id               TEXT PRIMARY KEY,
    work_item_id         TEXT NOT NULL REFERENCES work_items(id),
    decision             TEXT NOT NULL,
    holder_work_item_id  TEXT,
    holder_ref           TEXT NOT NULL,
    holder_kind          TEXT NOT NULL,
    shared               TEXT NOT NULL,
    cost                 REAL NOT NULL,
    threshold            REAL NOT NULL,
    fallback             INTEGER NOT NULL,
    approved_by          TEXT,
    at                   TEXT NOT NULL
  );
  CREATE INDEX claim_decisions_work_item ON claim_decisions (work_item_id, at);
  `,
  // 17: runtime settings overrides and their audit trail (design 2026-11-03, issue #157). `project_key` is '' for a
  // global override, else a project key. Values are JSON text. AUTOINCREMENT: audit rows keep commit order.
  `
  CREATE TABLE settings_overrides (
    setting_key  TEXT NOT NULL,
    project_key  TEXT NOT NULL DEFAULT '',
    value_json   TEXT NOT NULL,
    set_by       TEXT NOT NULL,
    set_at       TEXT NOT NULL,
    PRIMARY KEY (setting_key, project_key)
  );
  CREATE TABLE settings_changes (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key  TEXT NOT NULL,
    project_key  TEXT NOT NULL DEFAULT '',
    old_value    TEXT,
    new_value    TEXT,
    actor        TEXT NOT NULL,
    at           TEXT NOT NULL
  );
  `,
  // 18: interactive sessions (design §5, 2026-11-01, issue #112): an interactive run's person (user ID), transcript
  // URL and reported token total. Every other run, old rows included, keeps all three NULL.
  `
  ALTER TABLE runs ADD COLUMN actor_id TEXT;
  ALTER TABLE runs ADD COLUMN transcript_url TEXT;
  ALTER TABLE runs ADD COLUMN session_tokens INTEGER;
  `,
  // 19: worker processes (design §5 Coordination, 2026-11-07). One row per running WorkerPool, keyed by its
  // `<host>:<pid>`, replaced each tick and deleted on a clean stop. Readers skip rows older than lease_ms.
  `
  CREATE TABLE worker_processes (
    process_id   TEXT PRIMARY KEY,
    pid          INTEGER NOT NULL,
    host         TEXT NOT NULL,
    slots        INTEGER NOT NULL,
    max_slots    INTEGER NOT NULL,
    busy         INTEGER NOT NULL,
    index_base   INTEGER NOT NULL,
    started_at   TEXT NOT NULL,
    reported_at  TEXT NOT NULL
  );
  CREATE INDEX worker_processes_reported ON worker_processes (reported_at);
  `,
  // 20: run attempts (design §6, issue #207). One row per claim of a run, the claim that resumes a paused run
  // included; `lease_token` is the claim's fencing token, so only that claim's completion closes its row. Never
  // returned by the store. Backfill: every run with attempt >= 1 gets one row numbered by its attempt, from the run
  // row (status, start, finish, lease owner, outcome). A queued run with attempt >= 1 was paused (`paused`) or
  // reaped (`lease_expired`); failure class is failureClass(), tokens outcomeTokens() (src/core).
  `
  CREATE TABLE run_attempts (
    run_id         TEXT NOT NULL REFERENCES runs(id),
    attempt        INTEGER NOT NULL,
    lease_token    INTEGER NOT NULL,
    worker_id      TEXT,
    status         TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    error_code     TEXT,
    failure_class  TEXT,
    tokens         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, attempt)
  );
  INSERT INTO run_attempts (run_id, attempt, lease_token, worker_id, status, started_at, finished_at, error_code, failure_class, tokens)
  SELECT id, attempt, lease_token, lease_owner,
    CASE WHEN status <> 'queued' THEN status WHEN paused_at IS NOT NULL THEN 'paused' ELSE 'lease_expired' END,
    started_at,
    CASE WHEN status = 'running' THEN NULL ELSE COALESCE(finished_at, paused_at, updated_at) END,
    CASE
      WHEN status = 'failed' THEN json_extract(outcome, '$.error_code')
      WHEN status = 'queued' AND paused_at IS NULL THEN 'lease_expired'
    END,
    CASE
      WHEN status = 'failed' THEN CASE
        WHEN json_extract(outcome, '$.error_code') = 'rate_limited' THEN 'rate_limited'
        WHEN json_extract(outcome, '$.error_code') = 'agent_stalled' THEN 'stalled'
        WHEN json_extract(outcome, '$.infra') = 1 THEN 'infra'
        ELSE 'task'
      END
      WHEN status = 'queued' AND paused_at IS NULL THEN 'infra'
    END,
    CASE
      WHEN status = 'succeeded' THEN CASE
        WHEN json_type(outcome, '$.data.tokens') IN ('integer', 'real') AND json_extract(outcome, '$.data.tokens') >= 0
          THEN json_extract(outcome, '$.data.tokens')
        ELSE 0
      END
      WHEN status = 'failed' AND json_type(outcome, '$.usage') = 'object' THEN
        COALESCE(json_extract(outcome, '$.usage.input_tokens'), 0) + COALESCE(json_extract(outcome, '$.usage.output_tokens'), 0)
        + COALESCE(json_extract(outcome, '$.usage.cache_read_tokens'), 0) + COALESCE(json_extract(outcome, '$.usage.cache_write_tokens'), 0)
      ELSE 0
    END
  FROM runs WHERE attempt >= 1;
  `,
  // 21: local work items (issue #198). `item_messages`: the messages the controller would post as comments on an
  // item, one per (item, marker). `cli_commands`: the commands the CLI sends, read in `seq` order; `command_key` is
  // the idempotency key. `args` is JSON text. AUTOINCREMENT: seq only grows, even after deletes.
  // IF NOT EXISTS: safe to run again on a database whose recorded version was set back below 21.
  `
  CREATE TABLE IF NOT EXISTS item_messages (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    marker        TEXT NOT NULL,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (work_item_id, marker)
  );
  CREATE TABLE IF NOT EXISTS cli_commands (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    command_key  TEXT NOT NULL UNIQUE,
    actor        TEXT NOT NULL,
    command      TEXT NOT NULL,
    args         TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
  // 22: app command requests (issue #244). One row per command request; read in `seq` order. `request_key` is the
  // idempotency key. `args` is JSON text. AUTOINCREMENT: seq only grows, even after deletes. Table only: nothing
  // reads or writes it yet.
  // IF NOT EXISTS: safe to run again on a database whose recorded version was set back below 22.
  `
  CREATE TABLE IF NOT EXISTS app_command_requests (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_key  TEXT NOT NULL UNIQUE,
    actor        TEXT NOT NULL,
    command      TEXT NOT NULL,
    args         TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
  // 23: app command request handling (issue #245). `handled_at`: when the controller applied or refused the
  // request, NULL while pending. `refusal`: the refusal text posted for it, NULL when applied. Old rows stay pending.
  // The index serves the pending read (handled_at IS NULL, seq order).
  `
  ALTER TABLE app_command_requests ADD COLUMN handled_at TEXT;
  ALTER TABLE app_command_requests ADD COLUMN refusal TEXT;
  CREATE INDEX IF NOT EXISTS app_command_requests_pending ON app_command_requests (handled_at, seq);
  `,
  // 24: one thread table for every item and one command inbox (issue #281). `item_thread`: an item's messages, one
  // per (item, marker); `command_inbox`: the commands the CLI sends, read in `seq` order, `command_key` the
  // idempotency key. Each copies the rows of migration 21's table (`item_messages`, `cli_commands`) with their `seq`,
  // so a saved intake cursor still points at the same next command. The old tables stay; nothing reads or writes them.
  // IF NOT EXISTS and NOT EXISTS on the copy: safe to run again after the recorded version is set back below 24.
  `
  CREATE TABLE IF NOT EXISTS item_thread (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    marker        TEXT NOT NULL,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (work_item_id, marker)
  );
  CREATE TABLE IF NOT EXISTS command_inbox (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    command_key  TEXT NOT NULL UNIQUE,
    actor        TEXT NOT NULL,
    command      TEXT NOT NULL,
    args         TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  INSERT INTO item_thread (seq, work_item_id, marker, body, created_at)
  SELECT m.seq, m.work_item_id, m.marker, m.body, m.created_at FROM item_messages m
  WHERE NOT EXISTS (SELECT 1 FROM item_thread t WHERE t.seq = m.seq OR (t.work_item_id = m.work_item_id AND t.marker = m.marker))
  ORDER BY m.seq;
  INSERT INTO command_inbox (seq, command_key, actor, command, args, created_at)
  SELECT c.seq, c.command_key, c.actor, c.command, c.args, c.created_at FROM cli_commands c
  WHERE NOT EXISTS (SELECT 1 FROM command_inbox i WHERE i.seq = c.seq OR i.command_key = c.command_key)
  ORDER BY c.seq;
  `,
  // 25: merge checks (issue #248, design §5 Merge check). One row per item: its latest local merge check against
  // the base. `mergeable` is 0 or 1; `conflicts` is JSON text (the conflicting paths). Every replica reads it.
  // IF NOT EXISTS: safe to run again on a database whose recorded version was set back below 25.
  `
  CREATE TABLE IF NOT EXISTS merge_checks (
    work_item_id  TEXT PRIMARY KEY REFERENCES work_items(id),
    mergeable     INTEGER NOT NULL,
    conflicts     TEXT NOT NULL,
    head_sha      TEXT NOT NULL,
    base_sha      TEXT NOT NULL,
    checked_at    TEXT NOT NULL
  );
  `,
  // 26: local users (issue #318). Who may act from the local CLI and UI under the `local` auth plugin: one row per
  // factory user ID with its role (`owner`, `approver`, `requester`). `owner_slot` is 1 on the owner's row and NULL
  // on every other, so UNIQUE allows one owner. IF NOT EXISTS: safe to run again below 26.
  `
  CREATE TABLE IF NOT EXISTS local_users (
    user_id     TEXT PRIMARY KEY,
    role        TEXT NOT NULL,
    owner_slot  INTEGER UNIQUE,
    added_by    TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  `,
  // 27: GitHub sync records (design §5, GitHub call budget). `posted_comments`: one row per (source id, marker): the
  // comment's ID, URL and body hash once posted, and the failed posts (`attempts`, `next_attempt_at`) of the
  // controller's backoff. `label_states`: the status label last written per (source id, target), `target` being
  // `issue` or `pr:<n>`, with the claim (`claim_*`) of the write in progress. IF NOT EXISTS: safe to run again below 27.
  `
  CREATE TABLE IF NOT EXISTS posted_comments (
    source_id        TEXT NOT NULL,
    marker           TEXT NOT NULL,
    comment_id       TEXT,
    url              TEXT,
    body_hash        TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (source_id, marker)
  );
  CREATE TABLE IF NOT EXISTS label_states (
    source_id     TEXT NOT NULL,
    target        TEXT NOT NULL,
    status        TEXT,
    claim_token   TEXT,
    claim_status  TEXT,
    claim_until   TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (source_id, target)
  );
  `,
  // 28: host sleeps (design §5 Host sleep, issue #218). One row per sleep a worker saw: one of its waits ended more
  // than 60 s late. Keyed by (worker_id, woke_at), so recording one again keeps one row. `run_id`: the run the
  // worker held, null for an idle tick. Ids, a timestamp and a number only. IF NOT EXISTS: safe to run again below 28.
  `
  CREATE TABLE IF NOT EXISTS host_sleeps (
    worker_id  TEXT NOT NULL,
    woke_at    TEXT NOT NULL,
    gap_ms     INTEGER NOT NULL,
    run_id     TEXT,
    PRIMARY KEY (worker_id, woke_at)
  );
  CREATE INDEX IF NOT EXISTS host_sleeps_woke ON host_sleeps (woke_at);
  CREATE INDEX IF NOT EXISTS host_sleeps_run ON host_sleeps (run_id);
  `,
  // 29: the thread outbox (issue #282, design 05-sources "Thread first"). One row per thread entry that a source
  // must get: its source type, the target (JSON SourceRef), the item field its URL fills, the attempts, the next
  // try, a claim (token and expiry) so one replica posts it, and the delivery. Pending app command requests are
  // copied into `command_inbox` (key `app:<seq>`, args {"app_request": seq}), where the controller now
  // reads them. IF NOT EXISTS and NOT EXISTS on the copy: safe to run again after the version is set back below 29.
  `
  CREATE TABLE IF NOT EXISTS thread_outbox (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_seq       INTEGER NOT NULL UNIQUE REFERENCES item_thread(seq),
    work_item_id     TEXT NOT NULL REFERENCES work_items(id),
    source_type      TEXT NOT NULL,
    target           TEXT NOT NULL,
    link_field       TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT NOT NULL,
    claim_token      INTEGER NOT NULL DEFAULT 0,
    claimed_until    TEXT,
    delivered_at     TEXT,
    url              TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS thread_outbox_pending ON thread_outbox (delivered_at, source_type, next_attempt_at);
  CREATE INDEX IF NOT EXISTS thread_outbox_item ON thread_outbox (work_item_id, seq);
  INSERT INTO command_inbox (command_key, actor, command, args, created_at)
  SELECT 'app:' || r.seq, r.actor, r.command, json_object('app_request', r.seq), r.created_at FROM app_command_requests r
  WHERE r.handled_at IS NULL AND NOT EXISTS (SELECT 1 FROM command_inbox i WHERE i.command_key = 'app:' || r.seq)
  ORDER BY r.seq;
  `,
  // 30: when a cost hold started (issue #314, design §5 Hold policy): kept while the run stays held, whichever
  // holder the decision names, so a `run_after_minutes` timer does not restart. NULL on older rows.
  `
  ALTER TABLE claim_decisions ADD COLUMN held_since TEXT;
  `,
  // 31: improve reports and filed patterns (issue #306, design §7). `improve_reports`: one row per improve run, its
  // window and the failed runs it grouped (`failure_groups`: two or more runs, `patterns`: one run), JSON text.
  // `filed_patterns`: one row per pattern filed from a report, keyed by (project_key, pattern_key); written by the
  // improve filing (issue #308). IF NOT EXISTS: safe to run again on a database whose recorded version was set back below 31.
  `
  CREATE TABLE IF NOT EXISTS improve_reports (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL UNIQUE REFERENCES runs(id),
    project_key     TEXT NOT NULL,
    window_start    TEXT NOT NULL,
    window_end      TEXT NOT NULL,
    failure_groups  TEXT NOT NULL,
    patterns        TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS improve_reports_project ON improve_reports (project_key, created_at);
  CREATE TABLE IF NOT EXISTS filed_patterns (
    id           TEXT PRIMARY KEY,
    project_key  TEXT NOT NULL,
    pattern_key  TEXT NOT NULL,
    error_code   TEXT NOT NULL,
    detail       TEXT NOT NULL,
    report_id    TEXT NOT NULL REFERENCES improve_reports(id),
    filed_ref    TEXT,
    created_at   TEXT NOT NULL,
    UNIQUE (project_key, pattern_key)
  );
  `,
  // 32: standing approvals (design 05-standing-approvals, issue #298). `standing_rules`: one row per (gate, tier),
  // `enabled` 0 or 1, `set_by` a user ID. `standing_proposals`: one row per (gate, tier, run_length), the run of
  // unchanged approvals that reached `threshold`. Stored only: nothing acts on either yet. IF NOT EXISTS: safe to run
  // again on a database whose recorded version was set back below 32.
  `
  CREATE TABLE IF NOT EXISTS standing_rules (
    gate        TEXT NOT NULL,
    tier        INTEGER NOT NULL,
    enabled     INTEGER NOT NULL,
    set_by      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (gate, tier)
  );
  CREATE TABLE IF NOT EXISTS standing_proposals (
    id          TEXT PRIMARY KEY,
    gate        TEXT NOT NULL,
    tier        INTEGER NOT NULL,
    run_length  INTEGER NOT NULL,
    threshold   INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (gate, tier, run_length)
  );
  `,
  // 33: dependency edges re-read only when the issue changed (issue #254, design §5 Coordination). Each edge keeps
  // the source issue's updated_at it was read at; NULL on edges from before (the controller reads them once more).
  `
  ALTER TABLE dependency_edges ADD COLUMN source_updated_at TEXT;
  `,
  // 34: the same read time on the item (issue #254), so an item whose issue has no links also records when its
  // links were read. NULL: never read with a time, or marked stale; the controller reads its links on the next poll.
  `
  ALTER TABLE work_items ADD COLUMN edges_source_updated_at TEXT;
  `,
  // 35: the change columns beside pr_number (phase 1 of the change fields). `change_ref`: the PR number as text;
  // `change_url`: https://<label>/pull/<n> for a GitHub project key whose label cursor exists, else NULL (the same
  // string as prUrl in src/main.ts). Backfilled from pr_number; the store writes them with pr_number from now on.
  // Only NULL columns are filled and the indexes are IF NOT EXISTS: safe to run again below 35.
  `
  ALTER TABLE work_items ADD COLUMN change_ref TEXT;
  ALTER TABLE work_items ADD COLUMN change_url TEXT;
  ALTER TABLE unreviewed_merges ADD COLUMN change_ref TEXT;
  UPDATE work_items SET change_ref = CAST(pr_number AS TEXT) WHERE pr_number IS NOT NULL AND change_ref IS NULL;
  UPDATE work_items SET change_url = 'https://' || (SELECT c.value FROM cursors c WHERE c.name = 'project_label:' || work_items.project)
    || '/pull/' || pr_number
  WHERE pr_number IS NOT NULL AND change_url IS NULL AND substr(project, 1, 7) = 'github:'
    AND EXISTS (SELECT 1 FROM cursors c WHERE c.name = 'project_label:' || work_items.project);
  UPDATE unreviewed_merges SET change_ref = CAST(pr_number AS TEXT) WHERE change_ref IS NULL;
  CREATE INDEX IF NOT EXISTS work_items_change ON work_items (project, change_ref);
  CREATE UNIQUE INDEX IF NOT EXISTS unreviewed_merges_change ON unreviewed_merges (project, change_ref);
  `,
  // 36: alerts (design 05-alarms). `alerts`: one row per alert the alarm step stored, its code, count and scanned
  // detail (NULL when the egress scanner flagged it). `alert_patterns`: one row per pattern, the time it last
  // alerted; the conditional update on it is the 6-hour dedupe. IF NOT EXISTS: safe to run again.
  `
  CREATE TABLE IF NOT EXISTS alerts (
    id           TEXT PRIMARY KEY,
    pattern      TEXT NOT NULL,
    pattern_key  TEXT NOT NULL,
    error_code   TEXT NOT NULL,
    count        INTEGER NOT NULL,
    detail       TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at);
  CREATE TABLE IF NOT EXISTS alert_patterns (
    pattern_key    TEXT PRIMARY KEY,
    last_alert_at  TEXT NOT NULL
  );
  `,
  // 37: the mirror mark of CLI commands on sync-source items (design 05-sources, CLI intake). `mirror`: 1 when the
  // command is to be posted once on its item's source (a CLI command on a GitHub item), 0 otherwise and on every
  // older row. `mirrored_at`: when that post succeeded, NULL until then. The index serves the unmirrored read.
  `
  ALTER TABLE command_inbox ADD COLUMN mirror INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE command_inbox ADD COLUMN mirrored_at TEXT;
  CREATE INDEX IF NOT EXISTS command_inbox_mirror ON command_inbox (mirror, mirrored_at, seq);
  `,
  // 38: restart history (design 05-restarts). One row per unexpected child exit the supervisor recorded: its time,
  // its reason and when the store saw it. `restart_key` (the time and a hash of the reason) makes a second write of
  // the same restart a no-op. No backfill: older restarts were never stored. IF NOT EXISTS: safe to run again.
  `
  CREATE TABLE IF NOT EXISTS child_restarts (
    restart_key  TEXT PRIMARY KEY,
    at           TEXT NOT NULL,
    reason       TEXT NOT NULL,
    recorded_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS child_restarts_at ON child_restarts (at);
  `,
  // 39: one sync per project and a shared forge budget (design 05-coordination, sync lease; 05-sources, call budget).
  // `sync_leases`: the lease `sync:<type>:<project>` whose holder polls a sync source and delivers its outbox, like
  // `listener_leases` but keyed by name. `forge_budget`: the forge's rate limit per (project_key, plugin), a newer
  // `updated_at` wins. `item_thread.actor`: the account ID of a message that came from a source, NULL otherwise.
  `
  CREATE TABLE IF NOT EXISTS sync_leases (
    name        TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    token       INTEGER NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS forge_budget (
    project_key TEXT NOT NULL,
    plugin      TEXT NOT NULL,
    remaining   INTEGER NOT NULL,
    \`limit\`     INTEGER NOT NULL,
    reset_at    TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (project_key, plugin)
  );
  ALTER TABLE item_thread ADD COLUMN actor TEXT;
  `,
];
