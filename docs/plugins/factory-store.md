# FactoryStore

What it does: the factory's state (work items, runs, state changes, handoffs, leases). Every transition is a conditional update, so any number of controllers and workers can share it (architecture §4). The logic exists once in `SqlFactoryStore`; a backend is a `SqlDriver`.

**`mysql` is deprecated; SQLite is the only store (decision changed 2026-11-11, owner decision; current).** The factory serves one owner ([08-enterprise.md](../design/08-enterprise.md), One owner, many workers), and its workers share one SQLite file on one machine, so a shared MySQL store for a team has no reason left. `sqlite` is the only store and the default. Replaced by: `sqlite` (nothing new). Removal plan: a follow-up issue (number added when filed) removes the `mysql` plugin, `MysqlDriver`, `migrations/mysql/` and `src/impl/store/mysql/migrations.ts`, `npm run migrate`, the MySQL steps of `npm run setup`, and the MySQL test runs. Phase 1 (issue #590) is done: the checked-in config selects `sqlite` and `mysql` is refused at startup; new schema changes still ship a MySQL step until the driver goes.

Worker processes (2026-11-07, issue #209; design §5 Worker slots reported per process): `reportWorkerProcess(report)` writes one process's snapshot (`process_id` `<host>:<pid>`, `pid`, `host`, `slots`, `max_slots`, `busy`, `index_base`, `started_at`) with `reported_at` = the store clock's now; keyed by `process_id`, so a repeat write replaces the row (update, else insert; a concurrent first insert that loses updates). `listWorkerProcesses(max_age_ms)` returns the rows at most `max_age_ms` old, by host, pid, process_id (read-only). `removeWorkerProcess(process_id)` deletes one row on a clean stop. Table `worker_processes`: SQLite migration 19; MySQL step `migrations/mysql/0019-worker-processes.sql`, run by `npm run migrate`. Both backends share the contract tests in `tests/store-contract.test.ts`; on MySQL an upgrade test from state 18 runs the step through `MysqlMigrations`.

Schema changes of 2026-11-09 (issue #461), on both backends through timestamped migrations: index `worker_runs_ack` on `worker_runs (acknowledged_at, updated_at)` (`src/worker/migrations/20261109T1400-worker-runs-ack`, additive), so `listUnacknowledgedRuns` walks the unacknowledged runs instead of scanning every run; and the column `runtime_child_restarts.recorded_at` is dropped (`src/runtime/migrations/20261109T1401-runtime-drop-restart-recorded-at`, breaking: archived and verified first; on MySQL run by `npm run migrate` with the writers drained).

Plugins:

- `sqlite`: `SqlFactoryStore` over `SqliteDriver`, file at `<state_dir>/db/factory.db`. One machine. Selected by the checked-in config, and used when there is no `store` block.
  - Enable: `"store": { "type": "sqlite" }`. Secrets: none. Applies additive migrations when opened; `npm run migrate` applies the breaking ones and the data steps, and `npm run migrate -- --contract` the contract ones.
- `mysql`: deprecated and refused (phase 1 of #576, issue #590). A config with `"store": { "type": "mysql", … }` fails at startup with one line naming `"store": { "type": "sqlite" }`. Setup, `npm run migrate` and teardown have no MySQL path, and no `MYSQL_*` key is read from the secret file. The plugin and `MysqlDriver` stay, selected by nothing, until a later phase removes them; an existing MySQL database is not copied.

Switch back / disable: none. A store cannot be disabled: the factory has no state without one.

## History

- **`mysql` selectable** (decision changed 2026-11-11, issue #590). Before: the deprecated `mysql` plugin was still selected by the checked-in config, setup created its database, user and `MYSQL_PASSWORD`, `MYSQL_*` settings in the secret file overrode the `store` block, and `npm run migrate` ran its step files.
- **`mysql` deprecated, SQLite the only store** (decision changed 2026-11-11, owner decision). Before: `mysql` and `sqlite` were both supported stores, `mysql` was selected by the checked-in config, and it was the store for a team or several hosts.
- **Worker processes** (store methods added 2026-11-07, issue #209). Before: the store kept no per-process record; the only worker data was the lease owner on each running run.
