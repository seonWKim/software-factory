-- Dependency edges re-read only when the issue changed (issue #254, design §5 Coordination): the same column as
-- SQLite migration 33. `source_updated_at`: the source issue's updated_at the edge was read at. NULL on edges from
-- before this step: the controller reads their item's links once more.
-- Safe to rerun after a failure midway: the step is one ALTER, so a failed run leaves the table unchanged.

ALTER TABLE dependency_edges ADD COLUMN source_updated_at CHAR(24) NULL;
