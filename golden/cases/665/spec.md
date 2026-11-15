# Work item wi_b0a9b4344a0846ffad462538a9f0d709

Source: https://github.com/seonWKim/software-factory/issues/598

## Problem

Tasks store a due date and an optional due time (controller_tasks in schema/sqlite.sql, src/impl/store/sql/tasks.ts). Quick add reads only HH:MM (src/core/quick-add.ts), so it does not read 3pm. Nothing stores a duration. The Tasks page (web/src/views/tasks.tsx) has Inbox, Today, Upcoming and Projects tabs and no hour-by-hour timeline. No reminder fires at a task's time. The desktop app already shows owner notices (desktop/electron/common/notices.js, src/ui/notices-api.ts), but none for tasks.

This change adds a stored duration (default 30 minutes), a day timeline on the Tasks page where a task is dragged onto a time, a typed time such as 3pm in quick add, and a reminder at the task's time that reaches only the desktop app's notices. Recurrence keeps counting the next due date from the old due date (nextDueDate in src/core/tasks.ts); that does not change.

Given values:
- Default duration: 30 minutes, editable.
- Typed time example: 3pm (quick add).
- Done when 1: dragging a task onto the timeline, or typing at 3pm in quick add, sets its time; the default duration is 30 minutes and can be edited (test).
- Done when 2: a reminder fires at the task time through the path chosen in decision 3 (test with fakes).
- Allowed paths: src/, tests/, web/, docs/design/02-tasks.md, desktop/electron/common/notices.js, docs/design.md, schema/sqlite.sql.

Owner answers (binding, kept verbatim):
1. When a recurring task is completed, is the next due date counted from the old due date or from the completion day? Answer: From the old due date (like Todoist's 'every'); completion-based recurrence can come later (not the default)
2. Should the plain-words box draft a factory task (title, AS-IS to TO-BE, done-when) in this change or later? Answer: Later, after slice 3 (the default, accepted)
3. When the desktop app is not running, should a task reminder fall back to an OS notification? Answer: Desktop app only (the default, accepted)

Revision note: the schema snapshot (schema/sqlite.sql, checked by tests/architecture/schema-snapshot.test.ts) must change with the migration, so schema/sqlite.sql is in scope. The MySQL store was removed on 2026-11-12 (#654), so the migration is SQLite only.

## Done criteria
- Dragging a task onto a day's timeline on the Tasks page sets its due date and due time to the slot dropped on (web test).
- Quick add reads 3pm, 3:30pm and at 3pm as a due time of 15:00 or 15:30, and at is consumed only before a time; 13pm, 12:61pm and similar are refused with a reason and nothing stored (tests/quick-add.test.ts).
- A reminder is created for an open task with a due time at that time, using the injected Clock; a FakeClock test shows it fires at the task time (tests/ with fakes).
- A reminder reaches only the desktop app's notices; nothing is sent to Slack or another outbound target (test).
- A reminder fires once: a second poll after it fired sends nothing, through a conditional write on the stored sent-marker (test).
- A done or deleted task never sends a reminder (test).
- A timed task with no stored duration is planned and drawn as 30 minutes; a stored duration replaces it (tests/tasks.test.ts, web test).
- The duration can be edited from the Tasks page and from factory task edit, and a refusal writes nothing (tests/tasks-api.test.ts, tests/task-edit.test.ts).
- The controller migration adds duration_minutes and reminded_at (nullable) to controller_tasks in the SQLite schema (schema/sqlite.sql) and in the SQLite migration; it is additive, rerun-safe and has no backfill (tests/store-contract.test.ts; tests/architecture/schema-snapshot.test.ts stays green).
- A recurring task's next occurrence keeps its due time and duration, and its date is still counted from the old due date (existing tests stay green).
- docs/design/02-tasks.md states the new decision first, and the replaced decision appears as a History line.

## Desired output

Store and parser changes in src/ and schema/sqlite.sql; the timeline and typed-time UI in web/; a reminder unit in src/controller/units/task-reminders/ that writes a desktop-only notice; the notice's desktop display in desktop/electron/common/notices.js; tests for each done criterion; and the design topic file update in docs/design/02-tasks.md.

## Scope

In scope:
- A stored duration per task, default 30 minutes when none is stored.
- Quick add reads a time such as 3pm and an optional duration, with at consumed only before a time.
- A day timeline on the Tasks page where a task is dragged onto a slot.
- A schedule route that sets due date, due time and duration on an open task, through the store's update method.
- A reminder at a task's due time, created by a controller unit using the Clock, sent only to the desktop app's notices, once per task time.
- The reminder's behaviour when the app was closed, per owner answer 3 (desktop app only).
- The timestamped SQLite migration for the two new columns, and the matching schema/sqlite.sql.
- Tests with fakes for each done criterion.
- The design topic file update in docs/design/02-tasks.md.

Out of scope:
- Drafting a factory task from the plain-words box (owner answer 2: later, after slice 3).
- Completion-based recurrence (owner answer 1: later, if ever).
- An OS notification when the desktop app is not running (owner answer 3).
- Reminders in Slack, email or any other outbound target.
- Moving or editing calendar events; events on the timeline stay read-only.
- Overlap checks between tasks or events.
- A week or month timeline.
- Backfilling existing tasks with a duration or a reminder.
- Linking a task to a repository or a pull request.
- A MySQL migration (the MySQL store was removed on 2026-11-12, #654).

## Allowed paths (do not change files outside these)
- src/
- tests/
- web/
- schema/sqlite.sql
- docs/design/02-tasks.md
- docs/design.md
- desktop/electron/common/notices.js
- docs/design/