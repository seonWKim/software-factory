-- Standing approvals (design 05-standing-approvals, issue #298): the same tables as SQLite migration 32.
-- `standing_rules`: one row per (gate, tier), `enabled` 0 or 1, `set_by` a user ID. `standing_proposals`: one row
-- per (gate, tier, run_length), the run of unchanged approvals that reached `threshold`. Stored only: nothing acts
-- on either yet.
-- Safe to rerun: each table is created only when missing, its keys are part of it.

CREATE TABLE IF NOT EXISTS standing_rules (
  gate        VARCHAR(32) NOT NULL,
  tier        INT NOT NULL,
  enabled     INT NOT NULL,
  set_by      VARCHAR(128) NOT NULL,
  created_at  CHAR(24) NOT NULL,
  updated_at  CHAR(24) NOT NULL,
  PRIMARY KEY (gate, tier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS standing_proposals (
  id          VARCHAR(64) NOT NULL PRIMARY KEY,
  gate        VARCHAR(32) NOT NULL,
  tier        INT NOT NULL,
  run_length  INT NOT NULL,
  threshold   INT NOT NULL,
  created_at  CHAR(24) NOT NULL,
  UNIQUE KEY standing_proposals_run (gate, tier, run_length)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
