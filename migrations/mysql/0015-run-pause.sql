-- Pause and resume (design §5 Pause, issue #146). A paused run waits in queued with paused_at set; its session
-- and resume point are kept for the next claim. One worker_pauses row per paused worker loop, `*` for every
-- loop. Old rows keep the new run columns NULL. `seq` orders pauses made in the same millisecond.
-- Safe to rerun: the table is created only when missing, and the one ALTER comes last, so a failed run of
-- this step leaves the columns unadded and the next run adds them.

CREATE TABLE IF NOT EXISTS worker_pauses (
  seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  worker_id   VARCHAR(255) NOT NULL PRIMARY KEY,
  paused_by   VARCHAR(255) NOT NULL,
  paused_at   CHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
ALTER TABLE runs ADD COLUMN paused_at CHAR(24) NULL, ADD COLUMN paused_by VARCHAR(255) NULL, ADD COLUMN session_id VARCHAR(64) NULL, ADD COLUMN pause_state MEDIUMTEXT NULL;
