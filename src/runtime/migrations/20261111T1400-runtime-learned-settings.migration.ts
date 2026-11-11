// Learned settings (design 08-settings, issue #497): the value the daily improve run learned per project and key,
// and one audit row per learned write or reset with the evidence run IDs. Unique on (project, key, window_end), so a
// rerun of the same window writes nothing; a reset has no window (NULL, never equal to another). Additive: two new
// tables only, safe to rerun. Ids only: project keys, run ids and actor ids, never a display name.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS runtime_learned_settings (
    project_key  TEXT NOT NULL,
    setting_key  TEXT NOT NULL,
    value_json   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (project_key, setting_key)
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_learned_setting_changes (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key       TEXT NOT NULL,
    setting_key       TEXT NOT NULL,
    old_value         TEXT,
    new_value         TEXT,
    evidence_run_ids  TEXT NOT NULL,
    window_end        TEXT,
    actor             TEXT NOT NULL,
    at                TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS runtime_learned_setting_changes_window ON runtime_learned_setting_changes (project_key, setting_key, window_end)",
];

// Indexes inline, so each statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS runtime_learned_settings (
    project_key  VARCHAR(191) NOT NULL,
    setting_key  VARCHAR(64) NOT NULL,
    value_json   TEXT NOT NULL,
    updated_at   CHAR(24) NOT NULL,
    PRIMARY KEY (project_key, setting_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS runtime_learned_setting_changes (
    seq               BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    project_key       VARCHAR(191) NOT NULL,
    setting_key       VARCHAR(64) NOT NULL,
    old_value         TEXT NULL,
    new_value         TEXT NULL,
    evidence_run_ids  TEXT NOT NULL,
    window_end        CHAR(24) NULL,
    actor             VARCHAR(191) NOT NULL,
    at                CHAR(24) NOT NULL,
    UNIQUE KEY runtime_learned_setting_changes_window (project_key, setting_key, window_end)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
