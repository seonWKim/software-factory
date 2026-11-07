-- The read time of an item's dependency links (issue #254, design §5 Coordination): the same column as SQLite
-- migration 34. `edges_source_updated_at`: the issue updated_at the item's links were last read at, kept on the item
-- so an issue with no links records it too. NULL: never read with a time, or marked stale; read on the next poll.
-- Safe to rerun after a failure midway: the step is one ALTER, so a failed run leaves the table unchanged.

ALTER TABLE work_items ADD COLUMN edges_source_updated_at CHAR(24) NULL;
