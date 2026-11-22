## History

- **A delete is always refused while a sub-task is open** (until 2026-11-20, the Delete bullet of the edit, delete and sub-tasks decision). `deleteTask(id)` had no option: a task with an open sub-task could be deleted only after each sub-task was completed or deleted, from the CLI, chat and the dashboard alike.
- **Editing and deleting a task are not commands yet** (until 2026-11-12, the edit, delete and sub-tasks decision above). The #606 decision had `task add`, `task done` (later `task build`) and `task list` only; a task could not be changed or removed, and had no sub-tasks.
