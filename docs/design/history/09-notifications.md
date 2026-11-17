## History

- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the Table paragraph said the migration was for SQLite and MySQL, with no numbered MySQL step.
- **Finished notices and channels** (new decision, 2026-11-12). Before: only waits on the owner were noticed, and only the desktop shell showed them; a close stored nothing and nothing reached Slack.
- **Owner notices** (new decision, 2026-11-12). Before: nothing stored that an item began waiting on the owner; only the Needs-you list counted such items.
- **Notice title** (2026-11-12, brand phase 3). Before: every notice's title was the constant `Software Factory`. Now it is the app's name, Gongbang (`docs/design/09-desktop-app.md`).
- **Shell notices** (new decision, 2026-11-12, phase 2). Before: the stored notices were shown nowhere, and the plan was that the shell would mark each one delivered in the store. Now the macOS shell shows each once and keeps the shown ones in its app data folder; `delivered_at` stays unset.
