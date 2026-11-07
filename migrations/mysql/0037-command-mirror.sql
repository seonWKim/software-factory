-- The mirror mark of CLI commands on sync-source items (design 05-sources, CLI intake): the same columns and index
-- as SQLite migration 37. `mirror`: 1 when the command is to be posted once on its item's source (a CLI command on a
-- GitHub item), 0 otherwise and on every older row. `mirrored_at`: when that post succeeded, NULL until then.
-- Safe to rerun after a failure midway: the step is one ALTER, so a failed run leaves the table unchanged.

ALTER TABLE command_inbox ADD COLUMN mirror TINYINT NOT NULL DEFAULT 0, ADD COLUMN mirrored_at CHAR(24) NULL, ADD INDEX command_inbox_mirror (mirror, mirrored_at, seq);
