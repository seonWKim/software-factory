-- Implicit verdicts (design §4 and §6, issue #316): the same columns and index as SQLite migration 39. `implicit`: 1
-- for a verdict the factory read from a PR event (merge, a person's push, a revert), 0 for a `/verdict` comment and
-- on every older row. `pr_head`: the PR head commit the verdict is about, NULL on older rows and for a revert.
-- `comment_id` grows to 128 characters: an implicit verdict keeps its event key there (kind, item id and a sha).
-- Safe to rerun after a failure midway: the step is one ALTER, so a failed run leaves the table unchanged.

ALTER TABLE verdicts ADD COLUMN implicit TINYINT NOT NULL DEFAULT 0, ADD COLUMN pr_head VARCHAR(64) NULL, MODIFY comment_id VARCHAR(128) NOT NULL, ADD INDEX verdicts_head (work_item_id, pr_head);
