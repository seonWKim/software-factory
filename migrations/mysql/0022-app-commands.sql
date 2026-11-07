-- App command requests (issue #244): the same table as SQLite migration 22. One row per command request, read in
-- `seq` order; `request_key` is the idempotency key. `args` is JSON text. Table only: nothing reads or writes it yet.
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS app_command_requests (
  seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_key  VARCHAR(255) NOT NULL,
  actor        VARCHAR(128) NOT NULL,
  command      VARCHAR(64) NOT NULL,
  args         MEDIUMTEXT NOT NULL,
  created_at   CHAR(24) NOT NULL,
  UNIQUE KEY app_command_requests_key (request_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
