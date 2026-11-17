## History

- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the first decision was titled "No MySQL lines in teardown" and said the plan and hand-step list named no MySQL database; it now says the same without naming one, and calls the `test-mysql.url` entry in `src/setup-paths.ts` the old test-database URL file entry.
- **Stores** (decision changed 2026-11-11, issue #590). Before: on a shared MySQL store teardown reset only this machine, never connected to, dropped or altered the database, skipped saving it, and printed "the shared store was not touched" with the `DROP DATABASE` / `DROP USER` statements as a hand step; on SQLite it printed "MySQL: not selected".
