-- Run attempts (design §6, issue #207): the same table and backfill as SQLite migration 20. One row per claim of
-- a run; `lease_token` is the claim's fencing token. Backfill: every run with attempt >= 1 gets one row numbered by
-- its attempt, from the run row. A queued run with attempt >= 1 was paused (`paused`) or reaped (`lease_expired`).
-- Safe to rerun: the table is created only when missing and the backfill skips rows already there (INSERT IGNORE).

CREATE TABLE IF NOT EXISTS run_attempts (
  run_id         VARCHAR(64) NOT NULL,
  attempt        INT NOT NULL,
  lease_token    BIGINT NOT NULL,
  worker_id      VARCHAR(255) NULL,
  status         VARCHAR(16) NOT NULL,
  started_at     CHAR(24) NULL,
  finished_at    CHAR(24) NULL,
  error_code     VARCHAR(64) NULL,
  failure_class  VARCHAR(16) NULL,
  tokens         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT IGNORE INTO run_attempts (run_id, attempt, lease_token, worker_id, status, started_at, finished_at, error_code, failure_class, tokens) SELECT id, attempt, lease_token, lease_owner, CASE WHEN status <> 'queued' THEN status WHEN paused_at IS NOT NULL THEN 'paused' ELSE 'lease_expired' END, started_at, CASE WHEN status = 'running' THEN NULL ELSE COALESCE(finished_at, paused_at, updated_at) END, CASE WHEN status = 'failed' THEN JSON_UNQUOTE(JSON_EXTRACT(outcome, '$.error_code')) WHEN status = 'queued' AND paused_at IS NULL THEN 'lease_expired' END, CASE WHEN status = 'failed' THEN CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(outcome, '$.error_code')) = 'rate_limited' THEN 'rate_limited' WHEN JSON_UNQUOTE(JSON_EXTRACT(outcome, '$.error_code')) = 'agent_stalled' THEN 'stalled' WHEN JSON_EXTRACT(outcome, '$.infra') = CAST('true' AS JSON) THEN 'infra' ELSE 'task' END WHEN status = 'queued' AND paused_at IS NULL THEN 'infra' END, CASE WHEN status = 'succeeded' THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(outcome, '$.data.tokens')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL') AND JSON_EXTRACT(outcome, '$.data.tokens') >= 0 THEN CAST(JSON_EXTRACT(outcome, '$.data.tokens') AS SIGNED) ELSE 0 END WHEN status = 'failed' AND JSON_TYPE(JSON_EXTRACT(outcome, '$.usage')) = 'OBJECT' THEN COALESCE(CAST(JSON_EXTRACT(outcome, '$.usage.input_tokens') AS SIGNED), 0) + COALESCE(CAST(JSON_EXTRACT(outcome, '$.usage.output_tokens') AS SIGNED), 0) + COALESCE(CAST(JSON_EXTRACT(outcome, '$.usage.cache_read_tokens') AS SIGNED), 0) + COALESCE(CAST(JSON_EXTRACT(outcome, '$.usage.cache_write_tokens') AS SIGNED), 0) ELSE 0 END FROM runs WHERE attempt >= 1;
