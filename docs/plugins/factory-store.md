# FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

**`mysql` is deprecated; SQLite is the only store (decision changed 2026-11-11, owner decision; current).** The factory serves one owner ([08-enterprise.md](../design/08-enterprise.md), One owner, many workers), and its workers share one SQLite file on one machine, so a shared MySQL store for a team has no reason left. `sqlite` is the only store and the default. Replaced by: `sqlite` (nothing new). Removal plan: a follow-up issue (number added when filed) removes the `mysql` plugin, `MysqlDriver`, `migrations/mysql/` and `src/impl/store/mysql/migrations.ts`, `npm run migrate`, the MySQL steps of `npm run setup`, and the MySQL test runs; the checked-in config moves to `sqlite` before that. Until then the `mysql` plugin below still works, and new schema changes still ship its step.

Worker processes (2026-11-07, issue #209; design §5 Worker slots reported per process): `reportWorkerProcess(report)` writes one process's snapshot (`process_id` `<host>:<pid>`, `pid`, `host`, `slots`, `max_slots`, `busy`, `index_base`, `started_at`) with `reported_at` = the store clock's now; keyed by `process_id`, so a repeat write replaces the row (update, else insert; a concurrent first insert that loses updates). `listWorkerProcesses(max_age_ms)` returns the rows at most `max_age_ms` old, by host, pid, process_id (read-only). `removeWorkerProcess(process_id)` deletes one row on a clean stop. Table `worker_processes`: SQLite migration 19; MySQL step `migrations/mysql/0019-worker-processes.sql`, run by `npm run migrate`. Both backends share the contract tests in `tests/store-contract.test.ts`; on MySQL an upgrade test from state 18 runs the step through `MysqlMigrations`.

Schema changes of 2026-11-09 (issue #461), on both backends through timestamped migrations: index `worker_runs_ack` on `worker_runs (acknowledged_at, updated_at)` (`src/worker/migrations/20261109T1400-worker-runs-ack`, additive), so `listUnacknowledgedRuns` walks the unacknowledged runs instead of scanning every run; and the column `runtime_child_restarts.recorded_at` is dropped (`src/runtime/migrations/20261109T1401-runtime-drop-restart-recorded-at`, breaking: archived and verified first; on MySQL run by `npm run migrate` with the writers drained).

Plugins:

- `mysql`: `SqlFactoryStore` over `MysqlDriver`. Any number of processes on any hosts. Selected by the checked-in config.
  - Enable: `"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" }`.
  - Secrets: `MYSQL_PASSWORD` in the secret file (`npm run setup` creates the database, the user and the password). Settings: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER` in the secret file override the `store` block per machine (`docs/setup.md`).
  - Schema: numbered step files in `migrations/mysql/` (README there), run only by `npm run migrate` (`-- --status` lists pending steps, `-- --dry-run` shows what would run). Opening the store never applies a step: while steps are pending, startup refuses (`dev`, `worker`, `controller`, `status`, `ui`, `golden add` exit non-zero with "run `npm run migrate`") and `doctor` shows a FAIL line. A new database needs `npm run migrate` once after `npm run setup` creates it.
- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none. Builds the latest schema when opened; it has no step files, and `npm run migrate` exits non-zero on it.

Switch back / disable: set `store.type` to the other name. A store cannot be disabled: the factory has no state without one.

## History

- **`mysql` deprecated, SQLite the only store** (decision changed 2026-11-11, owner decision). Before: `mysql` and `sqlite` were both supported stores, `mysql` was selected by the checked-in config, and it was the store for a team or several hosts.
- **Worker processes** (store methods added 2026-11-07, issue #209). Before: the store kept no per-process record; the only worker data was the lease owner on each running run.
