-- One thread table for every item and one command inbox (issue #281): the same tables as SQLite migration 24.
-- `item_thread`: an item's messages, one per (item, marker). `command_inbox`: the commands the CLI sends, read in
-- `seq` order; `command_key` is the idempotency key. `args` is JSON text. Each copies the rows of step 0021's table
-- (`item_messages`, `cli_commands`) with their `seq`, so a saved intake cursor still points at the same next command.
-- The old tables stay; nothing reads or writes them.
-- Safe to rerun: each table is created only when missing, and each copy skips rows already copied.

CREATE TABLE IF NOT EXISTS item_thread (
  seq           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  work_item_id  VARCHAR(64) NOT NULL,
  marker        VARCHAR(255) NOT NULL,
  body          MEDIUMTEXT NOT NULL,
  created_at    CHAR(24) NOT NULL,
  UNIQUE KEY item_thread_marker (work_item_id, marker),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS command_inbox (
  seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  command_key  VARCHAR(255) NOT NULL,
  actor        VARCHAR(128) NOT NULL,
  command      VARCHAR(64) NOT NULL,
  args         MEDIUMTEXT NOT NULL,
  created_at   CHAR(24) NOT NULL,
  UNIQUE KEY command_inbox_key (command_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO item_thread (seq, work_item_id, marker, body, created_at) SELECT m.seq, m.work_item_id, m.marker, m.body, m.created_at FROM item_messages m WHERE NOT EXISTS (SELECT 1 FROM item_thread t WHERE t.seq = m.seq OR (t.work_item_id = m.work_item_id AND t.marker = m.marker)) ORDER BY m.seq;
INSERT INTO command_inbox (seq, command_key, actor, command, args, created_at) SELECT c.seq, c.command_key, c.actor, c.command, c.args, c.created_at FROM cli_commands c WHERE NOT EXISTS (SELECT 1 FROM command_inbox i WHERE i.seq = c.seq OR i.command_key = c.command_key) ORDER BY c.seq;
