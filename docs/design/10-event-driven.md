# 10. Event-driven factory (RFC 0015)

The factory is moving to independent, restartable actors that talk only through messages on a bus (RFC 0015,
kept outside the repo with the other RFCs). `PROGRESS.md` at the repo root holds the current snapshot of the
move: what exists now, what is still legacy, and the next milestone. This file holds the decisions already in
force.

## Current decisions

- **Every table carries its owner's prefix** (since 2026-11-08): `bus_`, `inbound_`, `controller_`, `worker_`,
  `outbound_`, `identity_`/`authz_`, `runtime_`, `ui_`, `ext_<name>_`. A component's code names only its own
  tables (`tests/architecture/table-ownership.test.ts`). The generated `schema/sqlite.sql` and
  `schema/mysql.sql` are the full table list; `npm run schema:snapshot` rewrites them, and
  `tests/architecture/schema-snapshot.test.ts` fails when they are stale.
- **Schema changes are timestamped migrations** (since 2026-11-08): `<yyyymmddThhmm>-<component>-<slug>.migration.ts`
  in the owning component's `migrations/` folder, found by discovery, recorded in `runtime_schema_migrations`.
  They run after the frozen numbered baseline (SQLite's list in `src/impl/store/sqlite/schema.ts`, MySQL steps
  up to `0041` in `migrations/mysql/`), which gets no new entries. SQLite applies them when it opens, in the
  same transaction as the baseline; MySQL applies them in `npm run migrate`, after the numbered steps.
- **No data moves in place** (since 2026-11-08). A breaking migration first writes every table it names to
  `backups/<time>-<id>/<table>.jsonl` with a manifest of row counts and checksums: beside the SQLite file, or
  under the state dir for MySQL. A fresh database is not backed up. Renames copy each table under its new
  name from its own DDL, verify every column of every row, and only then rename all old tables to
  `legacy_<old>` at once (one transaction on SQLite, one `RENAME TABLE` on MySQL). The legacy tables stay
  until a contract migration drops them after the owner confirms.
- **Rehearse before migrating** (since 2026-11-08): `npm run migrate -- --rehearse` copies the database
  (MySQL: one consistent snapshot into `<database>_rehearsal`, which the factory's MySQL user needs to be
  granted once; SQLite: `VACUUM INTO` a temp file), applies every pending step and migration to the copy,
  checks that each table still holds the same rows over its old columns (under its name or as its `legacy_`
  archive), and drops the copy. The live database is only read. Enterprise: run it before every `npm run
  migrate` on the shared store. Solo: optional, since SQLite also backs up before a breaking migration.
- **Runs execute as journaled steps** (since 2026-11-08, RFC 0015 M6, engine only; the legacy worker does not use it
  yet). `ExecutionEngine` (`src/worker/engine/`), default `journal`: each step's result is stored in
  `worker_run_steps` and returned instead of running the step again, so a resumed run skips finished steps;
  results are JSON, and a step can save a partial result (the agent's session id) for the attempt that resumes
  it. Writes are fenced by `worker_runs.lease_token`. On the worker's `heartbeat` tick the engine renews its
  leases and aborts steps past `start_to_close` or runs past `deadline_at` (created + `schedule_to_close`); on
  the `reaper` tick it fails runs past their deadline and takes over runs whose lease (`heartbeat` timeout)
  expired. A run journaled by another `code_version` is taken over only by code that declares it can resume
  it; otherwise it waits for a worker on that revision or fails at its deadline.
- **Architecture rules are tests** (since 2026-11-08): `tests/architecture/` with a ratchet of today's
  violations in `known-violations/*.json`, which may only shrink.

## History

- **Table names and schema steps** (decision changed 2026-11-08, RFC 0015 M1). Before: unprefixed tables shared
  by every part of the code, schema changes appended to SQLite's numbered list and to `migrations/mysql/`
  (still in force for steps up to `0041`, see 05-coordination.md "MySQL schema steps").
