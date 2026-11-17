## History

- **The reminder is a desktop notice only, sent up to a day late** (until 2026-11-13, the reminder channels decision above; owner answer 3 of #598). The `task-reminders` unit wrote no outbox intent, so a reminder never reached Slack or another `notify_channels` adapter, and `REMINDER_LOOKBACK_MS` was one day.
- **A task has a due date and an optional `HH:MM` time, no duration, no timeline and no reminder** (until 2026-11-13, the schedule a task decision above). Quick add read only `HH:MM`, nothing stored how long a task takes, the Tasks page had no hour-by-hour view, and no reminder fired at a task's time.
- **A calendar read had no time limit** (until 2026-11-12, the Google call timeout decision above). A Google that accepted the connection and never answered held the controller's tick until the process restarted.
