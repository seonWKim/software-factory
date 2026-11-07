-- Local users (issue #318): the same table as SQLite migration 26. Who may act from the local CLI and UI under the
-- `local` auth plugin: one row per factory user ID with its role (`owner`, `approver`, `requester`). `owner_slot` is
-- 1 on the owner's row and NULL on every other, so the unique key allows one owner.
-- Safe to rerun: the table is created only when missing.

CREATE TABLE IF NOT EXISTS local_users (
  seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  user_id     VARCHAR(128) NOT NULL PRIMARY KEY,
  role        VARCHAR(16) NOT NULL,
  owner_slot  TINYINT NULL,
  added_by    VARCHAR(128) NOT NULL,
  created_at  CHAR(24) NOT NULL,
  UNIQUE KEY local_users_owner (owner_slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
