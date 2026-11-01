-- Pull requests the factory did not open (design 2026-11-01, issue #113). Old items are origin 'factory'
-- with no head branch or recorded head. One unreviewed_merges row per PR that merged with no work item.

ALTER TABLE work_items ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'factory';
ALTER TABLE work_items ADD COLUMN head_branch VARCHAR(255) NULL;
ALTER TABLE work_items ADD COLUMN last_head_sha VARCHAR(64) NULL;
CREATE TABLE unreviewed_merges (
  id          VARCHAR(64) NOT NULL PRIMARY KEY,
  project     VARCHAR(255) NOT NULL,
  pr_number   INT NOT NULL,
  merge_sha   VARCHAR(64) NOT NULL,
  merger_id   VARCHAR(128) NULL,
  at          CHAR(24) NOT NULL,
  UNIQUE KEY unreviewed_merges_pr (project, pr_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX unreviewed_merges_at ON unreviewed_merges (at);
