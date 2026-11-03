# FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

Plugins:

- `mysql`: `SqlFactoryStore` over `MysqlDriver`. Any number of processes on any hosts. Selected by the checked-in config.
  - Enable: `"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" }`.
  - Secrets: `MYSQL_PASSWORD` in the secret file (`npm run setup` creates the database, the user and the password). Settings: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` in the secret file override the `store` block per machine (`docs/setup.md`).
  - Schema: numbered step files in `migrations/mysql/` (README there), run only by `npm run migrate` (`-- --status` lists pending steps, `-- --dry-run` shows what would run). Opening the store never applies a step: while steps are pending, startup refuses (`dev`, `worker`, `controller`, `status`, `ui`, `golden add` exit non-zero with "run `npm run migrate`") and `doctor` shows a FAIL line. A new database needs `npm run migrate` once after `npm run setup` creates it.
- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none. Builds the latest schema when opened; it has no step files, and `npm run migrate` exits non-zero on it.

Switch back / disable: set `store.type` to the other name. A store cannot be disabled: the factory has no state without one.

## History

No earlier decision is recorded for this topic.
