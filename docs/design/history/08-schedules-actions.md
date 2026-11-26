# History: 8. Operations: schedule actions

Replaced decisions of [../08-schedules-actions.md](../08-schedules-actions.md), newest first.

- **A schedule run row kept its outcome and output only, and the reaper, retention, cleanup, auto-grant, supervised restarts and migrations wrote no record a page could read** (the state before 2026-11-26; replaced 2026-11-26, local-task-tk_9a6d93d9 phase 1 of 3, by one `controller_activity` row per autonomous action, written in its change's transaction, and the run row's `reason` and `ref`). Lease expiries, retention batches and cleanups showed only in the logs; a restart only in `runtime_child_restarts`; a migration only in `runtime_schema_migrations`.
