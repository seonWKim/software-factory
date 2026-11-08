-- The base push (design 05-sources, Local items): the same table as SQLite migration 41. One row per local merge that
-- closed its item while a forge is selected: the base branch and the merge commit to bring to the remote, the attempts
-- and next try, a claim (token and expiry) so one replica pushes it, and how it finished: `pushed` (with the sha the
-- remote base now has) or `conflict` (the remote base moved and does not merge cleanly). One row per item.
-- Safe to rerun: the table is created only when missing, and its indexes are part of it.

CREATE TABLE IF NOT EXISTS base_pushes (
  seq              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  work_item_id     VARCHAR(64) NOT NULL,
  base_ref         VARCHAR(255) NOT NULL,
  merge_sha        VARCHAR(64) NOT NULL,
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  CHAR(24) NOT NULL,
  claim_token      INT NOT NULL DEFAULT 0,
  claimed_until    CHAR(24) NULL,
  finished_at      CHAR(24) NULL,
  outcome          VARCHAR(16) NULL,
  pushed_sha       VARCHAR(64) NULL,
  last_error       TEXT NULL,
  created_at       CHAR(24) NOT NULL,
  UNIQUE KEY base_pushes_item (work_item_id),
  KEY base_pushes_pending (finished_at, next_attempt_at),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
