-- The thread outbox (issue #282, design 05-sources "Thread first"): the same table as SQLite migration 28. One row
-- per thread entry a source must get: its source type, the target (JSON SourceRef), the item field its URL fills,
-- the attempts and next try, a claim (token and expiry) so one replica posts it, and the delivery. Pending app
-- command requests are copied into `command_inbox` (key `app:<seq>`, args {"app_request": seq}), where the
-- controller now reads them.
-- Safe to rerun: the table is created only when missing, the indexes are part of it, and the copy skips keys
-- already copied.

CREATE TABLE IF NOT EXISTS thread_outbox (
  seq              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  thread_seq       BIGINT NOT NULL,
  work_item_id     VARCHAR(64) NOT NULL,
  source_type      VARCHAR(32) NOT NULL,
  target           MEDIUMTEXT NOT NULL,
  link_field       VARCHAR(32) NULL,
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  CHAR(24) NOT NULL,
  claim_token      INT NOT NULL DEFAULT 0,
  claimed_until    CHAR(24) NULL,
  delivered_at     CHAR(24) NULL,
  url              TEXT NULL,
  last_error       TEXT NULL,
  created_at       CHAR(24) NOT NULL,
  UNIQUE KEY thread_outbox_entry (thread_seq),
  KEY thread_outbox_pending (delivered_at, source_type, next_attempt_at),
  KEY thread_outbox_item (work_item_id, seq),
  FOREIGN KEY (thread_seq) REFERENCES item_thread (seq),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO command_inbox (command_key, actor, command, args, created_at) SELECT CONCAT('app:', r.seq), r.actor, r.command, CAST(JSON_OBJECT('app_request', r.seq) AS CHAR), r.created_at FROM app_command_requests r WHERE r.handled_at IS NULL AND NOT EXISTS (SELECT 1 FROM command_inbox i WHERE i.command_key = CONCAT('app:', r.seq)) ORDER BY r.seq;
