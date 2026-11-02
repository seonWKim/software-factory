-- Identity links and one-time link codes (design 2026-11-01, issue #107). Links are keyed by provider and
-- subject only. A code is stored as its SHA-256 hash, never in plain text. `seq` orders links made in the
-- same millisecond (the SQL store orders by created_at, then seq).

CREATE TABLE user_links (
  seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  provider    VARCHAR(64) NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  user_id     VARCHAR(128) NOT NULL,
  created_at  CHAR(24) NOT NULL,
  PRIMARY KEY (provider, subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX user_links_user ON user_links (user_id);
CREATE TABLE link_codes (
  code_hash      CHAR(64) NOT NULL PRIMARY KEY,
  user_id        VARCHAR(128) NOT NULL,
  expires_at     CHAR(24) NOT NULL,
  failures       INT NOT NULL DEFAULT 0,
  used_at        CHAR(24) NULL,
  used_provider  VARCHAR(64) NULL,
  used_subject   VARCHAR(255) NULL,
  created_at     CHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX link_codes_live ON link_codes (used_at, expires_at);
