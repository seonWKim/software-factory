-- Interactive sessions (design §5, 2026-11-01, issue #112): an interactive run's person (user ID), transcript URL
-- and reported token total. Every other run, old rows included, keeps all three NULL. Notes and the last finish
-- stay in the run's input. One statement, so a failed run of this step adds nothing and the next run adds all three.

ALTER TABLE runs ADD COLUMN actor_id VARCHAR(128) NULL, ADD COLUMN transcript_url TEXT NULL, ADD COLUMN session_tokens BIGINT NULL;
