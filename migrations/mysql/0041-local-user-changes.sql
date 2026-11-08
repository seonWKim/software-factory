-- The audit of local users (design 08-permissions, issue #445): the same table as SQLite migration 41. One row per
-- add, role change or removal of a `local_users` row, written in the same transaction: `action` add | change |
-- remove, `old_role` NULL for an add, `new_role` NULL for a remove, `actor` the user who made the change. No backfill.
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS local_user_changes (
  seq       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id   VARCHAR(128) NOT NULL,
  action    VARCHAR(16) NOT NULL,
  old_role  VARCHAR(16) NULL,
  new_role  VARCHAR(16) NULL,
  actor     VARCHAR(128) NOT NULL,
  at        CHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
