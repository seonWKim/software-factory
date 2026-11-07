-- Local work items (issue #198): the same tables as SQLite migration 21. `item_messages`: the messages the
-- controller would post as comments on an item, one per (item, marker). `cli_commands`: the commands the CLI
-- sends, read in `seq` order; `command_key` is the idempotency key. `args` is JSON text.
-- Safe to rerun: each table is created only when missing.

CREATE TABLE IF NOT EXISTS item_messages (
  seq           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  work_item_id  VARCHAR(64) NOT NULL,
  marker        VARCHAR(255) NOT NULL,
  body          MEDIUMTEXT NOT NULL,
  created_at    CHAR(24) NOT NULL,
  UNIQUE KEY item_messages_marker (work_item_id, marker),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS cli_commands (
  seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  command_key  VARCHAR(255) NOT NULL,
  actor        VARCHAR(128) NOT NULL,
  command      VARCHAR(64) NOT NULL,
  args         MEDIUMTEXT NOT NULL,
  created_at   CHAR(24) NOT NULL,
  UNIQUE KEY cli_commands_key (command_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
