-- Implicit verdicts (issue #316, design §4 and §6): the same columns as SQLite migration 26. `implicit` is 0 for a
-- typed `/verdict`, 1 for one the controller derives from a merge, a person's push or a revert; old rows are explicit.
-- `pr_head` is the PR head the verdict is about, NULL when not known (every old row). The key serves the
-- one-verdict-per-head read. One statement, so a failed run leaves the table as it was and the step runs again.

ALTER TABLE verdicts
  ADD COLUMN implicit TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN pr_head VARCHAR(64) NULL,
  ADD KEY verdicts_head (work_item_id, pr_head);
