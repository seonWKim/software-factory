# Work item wi_657b518eef8740de8f9fe72e07e951ab

Source: https://github.com/seonWKim/software-factory/issues/606

## Problem

There is no task entity. Work items are the only entity, and `factory task` today means work items (create, list, show). Plain work cannot be stored, parsed from quick-add words, or kept out of triage. This is phase 1 of 2 of #591. It adds a `controller_tasks` table, kept apart from the work items table so triage never reads it, plus a pure quick-add parser, the `task add` command, and recurring completion. Revised after review: the table takes the controller prefix that the table-ownership test requires. The schema change is a timestamped migration under the controller's migrations folder, because the numbered baseline is frozen. `schema/sqlite.sql` and `schema/mysql.sql` are snapshots that a test checks on every `npm test`, so they are in scope.

## Done criteria
- A task created with no repository is stored in controller_tasks and appears in factory task list; no work item or triage run is created for it (test).
- factory task add <words> creates a task whose title is the words left after quick-add tokens are parsed out (CLI test).
- The quick-add parser accepts each form: today, tomorrow, YYYY-MM-DD, HH:MM, !1 to !3, #label, every day, every week, every month (one parser test per form).
- The quick-add parser rejects with a reason: a date such as 2026-13-01, a time such as 25:00, priority !0 or !4, an unknown every form such as every fortnight, a repeated field, a recurrence with no due date, and an empty title (one parser test each).
- Today and tomorrow resolve against the injected Clock, not the system clock (test).
- Completing a recurring task twice creates exactly one next occurrence (test).
- Every task write is a conditional update on the row's current state; applying the same change twice leaves the same state (test).
- A timestamped migration under src/controller/migrations/ creates controller_tasks on SQLite and on MySQL; the numbered SQLite list and migrations/mysql/ get no new entry.
- A migration test passes on a fresh database and on one at the previous version (test).
- tests/architecture/schema-snapshot.test.ts and tests/architecture/table-ownership.test.ts pass; schema/sqlite.sql lists controller_tasks.
- schema/mysql.sql lists controller_tasks with the MySQL DDL of the migration. If it cannot be regenerated here (no SF_TEST_MYSQL_URL), the report says so.
- tasks store the CLI user's ID from the environment in created_by, never a display name (test).
- SET_UP.md lists factory task add (and factory task done if decision 4 is Add); tests/local-cli.test.ts and tests/command-table.test.ts pass.
- docs/design/02-tasks.md states the current decision first; docs/design.md gets one line for it under section 2.
- npm test passes.

## Desired output

A controller_tasks table, separate from the work items table, with: id, title, list (a free #label, never a repository key), priority, due date and time, recurrence, created_by (CLI user ID), created_at, done_at, and parent_id (the task a recurring occurrence came from). Solo (SQLite) and enterprise (MySQL) behave the same: one timestamped migration carries the SQLite and MySQL DDL. Add the store methods (add, list, complete) to the store interface and to every implementation, including test fakes. Every write is a conditional update. The quick-add parser is a pure function in src/core/quick-add.ts with no import from outside src/core. task add goes through the existing command table (src/core/command-table.ts) and the local CLI (src/core/local-cli.ts), with the same permission level as task create. task list shows tasks in a section after the work items. Recurring completion sets done_at and inserts the next occurrence in one conditional write, keyed so a second run inserts nothing. If decision 4 is Add, factory task done <id> calls that completion. Create docs/design/02-tasks.md (new topic file) with the decisions, and add its line to docs/design.md. Do not add a numbered migrations/mysql step.

## Scope

In scope:
- The controller_tasks table in SQLite and MySQL, through one timestamped migration, with a migration test.
- The store methods to add, list and complete tasks, all conditional writes.
- The quick-add parser for the forms in the done criteria.
- factory task add in the local CLI and its entry in the command table.
- factory task list showing tasks after the work items.
- Recurring completion: one next occurrence per completion, idempotent.
- factory task done <id>, only if decision 4 is Add.
- The design topic docs/design/02-tasks.md and its index line.
- SET_UP.md lines for the new commands.
- Regenerated schema snapshots for the new table.

Out of scope:
- Triage, implementation, review or any work-item behaviour change.
- Dashboard, status page and Slack views of tasks.
- Reminders, notifications or due-date alerts.
- Editing or deleting tasks after creation.
- Recurrence forms beyond day, week and month.
- Linking a task to a repository, a work item or a pull request.
- Backfilling existing items into tasks.
- A numbered MySQL step (migrations/mysql/0044-tasks.sql) or any new entry in the frozen SQLite numbered list.
- Any table name without the controller_ prefix.

## Allowed paths (do not change files outside these)
- src/
- schema/
- tests/
- docs/design/02-tasks.md
- docs/design.md
- SET_UP.md
- migrations/mysql/
- docs/design/