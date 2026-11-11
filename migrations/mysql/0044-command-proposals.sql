-- Command proposals (design 04-gate-commands, issue #584): the same table as SQLite migration 43. One row per proposed
-- command of a plain-language reply, keyed by (proposal_id, idx), inserted once per reply. `status` is pending,
-- applied, refused or cancelled; `answered_by` the factory user who confirmed or cancelled it; `refusal` why a confirm
-- was refused. IDs only, never display names. 0044 because 0043 is merge-evaluations. No backfill.
-- Safe to rerun: the table is created only when missing, and its key is part of it.

CREATE TABLE IF NOT EXISTS controller_command_proposals (
  proposal_id   VARCHAR(64) NOT NULL,
  idx           INT NOT NULL,
  work_item_id  VARCHAR(64) NOT NULL,
  command       VARCHAR(32) NOT NULL,
  args          TEXT NOT NULL,
  author_id     VARCHAR(191) NOT NULL,
  status        VARCHAR(16) NOT NULL,
  answered_by   VARCHAR(191) NULL,
  refusal       TEXT NULL,
  created_at    CHAR(24) NOT NULL,
  answered_at   CHAR(24) NULL,
  PRIMARY KEY (proposal_id, idx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
