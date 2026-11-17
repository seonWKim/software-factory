## History

- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the migration paragraph said there was no numbered MySQL step; the idempotency paragraph said a MySQL skipped duplicate would cost a round trip on every poll; the Solo and enterprise paragraph said enterprise used MySQL with the migration run by `npm run migrate`.
- **Signal ledger** (new decision, 2026-11-11, issue #491). Before: the signals were spread over state changes, verdicts and runs, and none recorded the role or standing rule it was about.
