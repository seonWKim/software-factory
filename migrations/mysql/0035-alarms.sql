-- Alerts (design 05-alarms): the same tables as SQLite migration 35. `alerts`: one row per alert the alarm step
-- stored, its code, count and egress-scanned detail (NULL when the scanner flagged it). `alert_patterns`: one row
-- per pattern, the time it last alerted; the conditional update on it is the 6-hour dedupe, so replicas that see
-- one pattern at once store one alert.
-- Safe to rerun: each table is created only when missing, its keys are part of it.

CREATE TABLE IF NOT EXISTS alerts (
  id           VARCHAR(64) NOT NULL PRIMARY KEY,
  pattern      VARCHAR(32) NOT NULL,
  pattern_key  VARCHAR(128) NOT NULL,
  error_code   VARCHAR(64) NOT NULL,
  count        INT NOT NULL,
  detail       TEXT NULL,
  created_at   CHAR(24) NOT NULL,
  KEY alerts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS alert_patterns (
  pattern_key    VARCHAR(128) NOT NULL PRIMARY KEY,
  last_alert_at  CHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
