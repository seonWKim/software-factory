# 5. Interactive sessions

**Decided 2026-11-01 (issue #112).** A person's own LLM session on an item is a new run kind, `interactive`: written running with a lease by `factory session start`, with the person's user ID as its actor, never claimed by a worker, and counted as the item's branch writer, so implement and update runs wait while their item overlaps an open session and a session does not start over a running one. Gates at `session finish`: the scope gate, the size gate (the same `max_diff_lines` and `max_diff_files`), the floor check (a hit refuses the finish; no tier is raised) and `repo.test_command`; push and PR only through the broker. A finished session moves the item to REVIEW with a review run. An abandoned session (`abandoned`), or one whose lease expired (the reaper writes `session_lost` and never requeues it), releases the item: RUNNING, `blocked_on: human`, `blocked_reason: session_released`, nothing queued. Exception: the session's LLM runs as the owner with the owner's access, outside the run-folder rule (architecture §5); the gates at finish are the factory's check, not a sandbox.

- **Commands:** `factory session start | status | note | finish | abandon` (flags in `SET_UP.md`).
- **Schema:** migration 18 (SQLite) adds the run columns `actor_id` (the person's user ID, never a display name), `transcript_url` and `session_tokens`; MySQL: step `migrations/mysql/0018-run-session.sql`, the same three columns. Every other run, old rows included, keeps them NULL. A session's notes and its last `finish` attempt are kept in the run's `input`. `session_tokens` is added to the item's `token_cost` once, when the run ends.

## History

- 2026-11-07: the first version kept the actor, transcript and token fields inside the run's `input` JSON with no schema step, and put this decision in the `docs/design.md` index. Replaced by the run columns above (the work item's migration criterion) and this topic file.
