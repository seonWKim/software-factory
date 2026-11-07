-- Improve reports and filed patterns (issue #306, design §7): the same tables as SQLite migration 31.
-- `improve_reports`: one row per improve run, its window and the failed runs it grouped (`failure_groups`: two or
-- more runs, `patterns`: one run), JSON text. `filed_patterns`: one row per pattern filed from a report, keyed by
-- (project_key, pattern_key); created empty, nothing writes it yet.
-- Safe to rerun: each table is created only when missing, its keys are part of it.

CREATE TABLE IF NOT EXISTS improve_reports (
  id              VARCHAR(64) NOT NULL PRIMARY KEY,
  run_id          VARCHAR(64) NOT NULL,
  project_key     VARCHAR(255) NOT NULL,
  window_start    CHAR(24) NOT NULL,
  window_end      CHAR(24) NOT NULL,
  failure_groups  MEDIUMTEXT NOT NULL,
  patterns        MEDIUMTEXT NOT NULL,
  created_at      CHAR(24) NOT NULL,
  UNIQUE KEY improve_reports_run (run_id),
  KEY improve_reports_project (project_key, created_at),
  FOREIGN KEY (run_id) REFERENCES runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS filed_patterns (
  id           VARCHAR(64) NOT NULL PRIMARY KEY,
  project_key  VARCHAR(255) NOT NULL,
  pattern_key  VARCHAR(64) NOT NULL,
  error_code   VARCHAR(64) NOT NULL,
  detail       TEXT NOT NULL,
  report_id    VARCHAR(64) NOT NULL,
  filed_ref    VARCHAR(255) NULL,
  created_at   CHAR(24) NOT NULL,
  UNIQUE KEY filed_patterns_key (project_key, pattern_key),
  FOREIGN KEY (report_id) REFERENCES improve_reports (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
