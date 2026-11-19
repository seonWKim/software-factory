## History

- 2026-11-07: the first version kept the actor, transcript and token fields inside the run's `input` JSON with no schema step, and put this decision in the `docs/design.md` index. Replaced by the run columns above (the work item's migration criterion) and this topic file.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: the schema bullet read "migration 18 (SQLite) adds the run columns ...; MySQL: step `migrations/mysql/0018-run-session.sql`, the same three columns."
- **A queued implement or update run is taken over on start** (decision changed 2026-11-19). Before: `factory session start` refused, with nothing changed, on an item with a queued or running implement or update run. Now a queued one is cancelled and the interactive task starts; a running one still refuses.
