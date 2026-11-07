-- When a cost hold started (issue #314, design §5 Hold policy): the same column as SQLite migration 30. Kept while
-- the run stays held, whichever holder the decision names, so a `run_after_minutes` timer does not restart. Older
-- rows keep it NULL.
-- One statement: a failed run adds nothing, and the next run adds it.

ALTER TABLE claim_decisions ADD COLUMN held_since CHAR(24) NULL;
