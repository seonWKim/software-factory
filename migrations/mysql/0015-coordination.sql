-- Coordination (design §5, 2026-11-03, issue #115): the same tables and columns as SQLite migration 15,
-- plus `seq` for insertion order.

ALTER TABLE work_items ADD COLUMN files_to_change MEDIUMTEXT NULL;
ALTER TABLE work_items ADD COLUMN pr_files MEDIUMTEXT NULL;
CREATE TABLE dependency_edges (
  seq           BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  work_item_id  VARCHAR(64) NOT NULL,
  depends_on    VARCHAR(255) NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  state         VARCHAR(16) NOT NULL,
  created_at    CHAR(24) NOT NULL,
  updated_at    CHAR(24) NOT NULL,
  PRIMARY KEY (work_item_id, depends_on),
  KEY dependency_edges_target (depends_on),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE file_conflicts (
  seq          BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  project_key  VARCHAR(191) NOT NULL,
  path         VARCHAR(400) NOT NULL,
  event_key    VARCHAR(128) NOT NULL,
  at           CHAR(24) NOT NULL,
  PRIMARY KEY (project_key, path, event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE claim_decisions (
  seq                  BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  run_id               VARCHAR(64) NOT NULL PRIMARY KEY,
  work_item_id         VARCHAR(64) NOT NULL,
  decision             VARCHAR(16) NOT NULL,
  holder_work_item_id  VARCHAR(64) NULL,
  holder_ref           VARCHAR(255) NOT NULL,
  holder_kind          VARCHAR(16) NOT NULL,
  shared               MEDIUMTEXT NOT NULL,
  cost                 DOUBLE NOT NULL,
  threshold            DOUBLE NOT NULL,
  fallback             TINYINT NOT NULL,
  approved_by          VARCHAR(128) NULL,
  at                   CHAR(24) NOT NULL,
  KEY claim_decisions_work_item (work_item_id, at),
  FOREIGN KEY (work_item_id) REFERENCES work_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
