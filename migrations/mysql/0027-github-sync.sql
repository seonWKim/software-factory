-- GitHub sync records (design §5, GitHub call budget): the same tables as SQLite migration 27.
-- `posted_comments`: one row per (source id, marker): the comment's ID, URL and body hash once posted, and the
-- failed posts (`attempts`, `next_attempt_at`) of the controller's backoff. `label_states`: the status label last
-- written per (source id, target), `target` being `issue` or `pr:<n>`, with the claim of the write in progress.
-- Safe to rerun: each table is created only when missing.

CREATE TABLE IF NOT EXISTS posted_comments (
  seq              BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  source_id        VARCHAR(255) NOT NULL,
  marker           VARCHAR(255) NOT NULL,
  comment_id       VARCHAR(64) NULL,
  url              VARCHAR(1024) NULL,
  body_hash        CHAR(64) NULL,
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  CHAR(24) NULL,
  created_at       CHAR(24) NOT NULL,
  updated_at       CHAR(24) NOT NULL,
  PRIMARY KEY (source_id, marker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS label_states (
  seq           BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  source_id     VARCHAR(255) NOT NULL,
  target        VARCHAR(32) NOT NULL,
  status        VARCHAR(32) NULL,
  claim_token   VARCHAR(64) NULL,
  claim_status  VARCHAR(32) NULL,
  claim_until   CHAR(24) NULL,
  updated_at    CHAR(24) NOT NULL,
  PRIMARY KEY (source_id, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
