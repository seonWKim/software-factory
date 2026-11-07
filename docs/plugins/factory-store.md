# FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

Worker processes (2026-11-07, issue #209; design §5 Worker slots reported per process): `reportWorkerProcess(report)` writes one process's snapshot (`process_id` `<host>:<pid>`, `pid`, `host`, `slots`, `max_slots`, `busy`, `index_base`, `started_at`) with `reported_at` = the store clock's now; keyed by `process_id`, so a repeat write replaces the row (update, else insert; a concurrent first insert that loses updates). `listWorkerProcesses(max_age_ms)` returns the rows at most `max_age_ms` old, by host, pid, process_id (read-only). `removeWorkerProcess(process_id)` deletes one row on a clean stop. Table `worker_processes`: SQLite migration 18; MySQL step 18 `worker-processes` (`WORKER_PROCESSES_STEP` in `src/impl/store/mysql/schema.ts`), not yet listed in `INLINE_STEPS`, so `npm run migrate` does not run it until it is (known gap: one `INLINE_STEPS` entry in `src/impl/store/mysql/migrations.ts`, or `migrations/mysql/0018-worker-processes.sql`). Both backends share the contract tests in `tests/store-contract.test.ts`; on MySQL the worker-process tests and an upgrade test from state 17 apply step 18 through `MysqlMigrations` with a steps dir that adds it.

Plugins:

- `mysql`: `SqlFactoryStore` over `MysqlDriver`. Any number of processes on any hosts. Selected by the checked-in config.
  - Enable: `"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" }`.
  - Secrets: `MYSQL_PASSWORD` in the secret file (`npm run setup` creates the database, the user and the password). Settings: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` in the secret file override the `store` block per machine (`docs/setup.md`).
  - Schema: numbered step files in `migrations/mysql/` (README there), run only by `npm run migrate` (`-- --status` lists pending steps, `-- --dry-run` shows what would run). Opening the store never applies a step: while steps are pending, startup refuses (`dev`, `worker`, `controller`, `status`, `ui`, `golden add` exit non-zero with "run `npm run migrate`") and `doctor` shows a FAIL line. A new database needs `npm run migrate` once after `npm run setup` creates it.
- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none. Builds the latest schema when opened; it has no step files, and `npm run migrate` exits non-zero on it.

Switch back / disable: set `store.type` to the other name. A store cannot be disabled: the factory has no state without one.

## History

- **Worker processes** (store methods added 2026-11-07, issue #209). Before: the store kept no per-process record; the only worker data was the lease owner on each running run.
