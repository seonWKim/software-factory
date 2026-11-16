## History

- 2026-11-07: the first version kept the actor, transcript and token fields inside the run's `input` JSON with no schema step, and put this decision in the `docs/design.md` index. Replaced by the run columns above (the work item's migration criterion) and this topic file.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: the schema bullet read "migration 18 (SQLite) adds the run columns ...; MySQL: step `migrations/mysql/0018-run-session.sql`, the same three columns."
