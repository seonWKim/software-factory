-- App command request handling (issue #245): the same columns as SQLite migration 23. `handled_at`: when the
-- controller applied or refused the request, NULL while pending. `refusal`: the refusal text posted for it, NULL
-- when applied. Old rows stay pending. The index serves the pending read (handled_at IS NULL, seq order).
-- Safe to rerun after a failure midway: the one ALTER adds both columns and the index together, so a failed run
-- leaves the table unchanged and the next run adds all three.

ALTER TABLE app_command_requests ADD COLUMN handled_at CHAR(24) NULL, ADD COLUMN refusal MEDIUMTEXT NULL, ADD INDEX app_command_requests_pending (handled_at, seq);
