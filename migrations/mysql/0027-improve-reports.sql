-- Improve reports and filed patterns (issue #306, design §7): the same tables as SQLite migration 27.
-- `improve_reports`: one row per improve run: its window and its groups; `failure_groups` and `one_run_patterns`
-- are JSON text (run IDs and item IDs per error code and normalized detail). `filed_patterns`: a pattern filed from
-- a report, one per (project_key, pattern_key); created empty, nothing writes it yet. `project_key` holds only
-- project keys (never owner/name), like settings_overrides, so the project-key data step has nothing to rewrite.
-- Safe to rerun: each table is created only when missing.

CREATE TABLE IF NOT EXISTS improve_reports (
  run_id            VARCHAR(64) NOT NULL PRIMARY KEY,
  project_key       VARCHAR(255) NOT NULL,
  window_start      CHAR(24) NOT NULL,
  window_end        CHAR(24) NOT NULL,
  failure_groups    MEDIUMTEXT NOT NULL,
  one_run_patterns  MEDIUMTEXT NOT NULL,
  created_at        CHAR(24) NOT NULL,
  KEY improve_reports_project (project_key, created_at),
  FOREIGN KEY (run_id) REFERENCES runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS filed_patterns (
  id             VARCHAR(64) NOT NULL PRIMARY KEY,
  project_key    VARCHAR(255) NOT NULL,
  pattern_key    VARCHAR(255) NOT NULL,
  error_code     VARCHAR(64) NOT NULL,
  detail         MEDIUMTEXT NOT NULL,
  report_run_id  VARCHAR(64) NOT NULL,
  link           VARCHAR(512) NULL,
  created_at     CHAR(24) NOT NULL,
  UNIQUE KEY filed_patterns_key (project_key, pattern_key),
  FOREIGN KEY (report_run_id) REFERENCES improve_reports (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
