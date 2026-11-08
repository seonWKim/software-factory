# RFC 0015 refactor: progress

The current snapshot of the architecture while the factory moves to RFC 0015 (an event-driven factory of
independent, restartable actors). The RFC and the target schema live in `~/Desktop/software-factory-rfcs/`
(`0015-event-driven-factory.md`, `0015-target-schema.sql`). This file says what exists **today** on the
`refactor/rfc-0015` branch, what is still legacy, and what comes next. It is updated with every milestone.

The refactor runs in the main session, not through the factory. The factory (supervisor, cron loops,
background agents) is paused until it lands.

## Milestones

| M | Milestone | Status |
|---|---|---|
| 0 | Foundations: shared kernel, architecture tests + ratchet, schema snapshot, migration safety kit | done (6235fc9) |
| 1 | Table renames to `<component>_` prefixes (backup → expand → backfill → verify → swap) | done; rehearsed on a copy of the live MySQL DB |
| 2 | Components and discovery (`src/<component>/`, `index.ts`, no central wiring) | — |
| 3 | Bus (EventBus, sql plugin, topics, outbox/inbox, retry scheduler) | — |
| 4 | Inbound (adapters + normalizers; GitHub sync out of the controller) | — |
| 5 | Controller units (router + pure `decide()` units; `controller.ts` gone) | — |
| 6 | Workers (step journal, ExecutionEngine, timeouts, heartbeat/reaper) | engine core on `refactor/rfc-0015-m6-engine`: `ExecutionEngine`, `journal` engine, `worker_run_steps`, contract test; `worker.ts` not ported yet |
| 7 | Outbound (aggregators, batches, delivery handlers; no forge writes in workers) | — |
| 8 | Merge queue | — |
| 9 | Identity and passports | — |
| 10 | Extension points (hooks, roles, Rule of Two, settings-monotonic) | — |
| 11 | Cleanup (contract migrations, docs, empty ratchet lists) | — |

## Architecture today

```
src/
  shared/              NEW  envelope (ids-only payloads), defineHandler, defineTopic (+ partitions, backoff),
                            ticks/ (TickGenerator; time-based and manual plugins). Imports nothing outside itself.
  runtime/registry/    NEW  discovery of *.handler.ts and *.topic.ts; dispatch rules (a command has one handler)
  state/               NEW  SqlDriver interface (moved from impl/store/sql/driver.ts), schema snapshots, discovery,
                            migrate/: backup.ts (backup, verify a copy, restore; order-independent checksums),
                            migration.ts (defineMigration), runner.ts (timestamped migrations after the frozen
                            baseline, recorded in runtime_schema_migrations), copy-tables.ts (rename by copy +
                            verify, old tables to legacy_*), rehearse.ts (D8: fingerprint, then no row lost)
                            migrations/20261108T1300-state-prefix-tables: the M1 rename of 39 tables
  worker/engine/       NEW  ExecutionEngine (index.ts) and the journal engine (plugins/journal/): named steps journaled
                            in worker_run_steps (a stored result wins), lease fencing by token, heartbeat and reaper
                            ticks, named timeouts, code_version pinning. Not wired into the legacy worker yet
  worker/migrations/   NEW  20261108T1730-worker-run-journal: worker_run_steps, worker_runs.code_version/deadline_at
  core/                LEGACY  controller.ts (4,959 lines), worker.ts (3,098), policy, coordination, ...
  impl/                LEGACY  plugin implementations (store, github, slack, sandbox, runner, ...)
  interfaces/          LEGACY  FactoryStore (136 methods) and the other plugin interfaces
  ui/                  LEGACY  HTTP API and pages for web/
  compose.ts, main.ts  LEGACY  hand wiring and the CLI switch
schema/                NEW  sqlite.sql, mysql.sql: generated snapshots of a fresh migration (npm run schema:snapshot)
tests/architecture/    NEW  dependency-direction, file-budget, no-clock, table-ownership, schema-snapshot,
                            registry-rules (handler-layout, dispatch-coverage, topic-ownership, envelope-shape),
                            migration-naming; known-violations/*.json are the ratchet lists (they only shrink)
```

The store (`impl/store/sql`) now speaks the prefixed names; the old tables sit as `legacy_<old>` until M11.
`npm run migrate -- --rehearse` runs pending migrations on a copy of the database and checks every row survived.

Data flow is still the legacy one: the controller tick polls sources, decides, writes the store and the
thread outbox; workers claim runs from the store and push/open PRs themselves.

## Ratchet (known violations)

| Test | Count | Meaning |
|---|---|---|
| table-ownership | 1 | `schema_migrations` (SQLite baseline bookkeeping; goes when M11 squashes the baseline) |
| file-budget | see `known-violations/file-budget.json` | src files over 600 lines |
| no-clock | see `known-violations/no-clock.json` | legacy clock reads and timers |
| dependency-direction | 0 | new components only; legacy folders are checked by tests/boundaries.test.ts |

## Decisions taken while implementing

- 2026-11-08: the merge queue moved after the controller units (M8), so it is built once on the new structure.
- 2026-11-08: table renames come first (M1), so every later step writes SQL against the final names.
- 2026-11-08: the registry lives in `src/runtime/registry/`, not `src/shared/`, because discovery reads the file
  system and `shared/` does no I/O.
- 2026-11-08: the time-based tick generator is a plain class for now; it becomes a `*.plugin.ts` choice when the
  plugin registry moves into the runtime (M2).

- 2026-11-08: `command_inbox` and `app_command_requests` are renamed separately in M1 (`inbound_commands`,
  `inbound_app_requests`); they merge into one `inbound_commands` in M4 when their code is rebuilt (D7).
- 2026-11-08: `cli_commands` and `item_messages` had no code left; M1 only archives them as `legacy_*`.
- 2026-11-08: tests that rolled a migrated database back to an old schema step and re-ran it were removed
  (they cannot work once the store only knows the new names); upgrade tests from old states still run.
- 2026-11-08 (M6 engine): `ExecutionEngine` grew `claim`, `complete`, `attach`, `heartbeat` and `reap` beside the
  RFC's `step`, so a Temporal or Restate engine can own leases too. The journal is keyed by (run, step) as in the
  target schema; `attempt` is the attempt that last ran the step. Engine time is the latest tick's (no clock).
- 2026-11-08: added `npm run migrate -- --rehearse` (D8) and wired the D1 backup folder
  (`<stateDir>/db/backups`) into MySQL `npm run migrate`, which had none.

## Live database

Not migrated yet. The owner runs `npm run migrate` after reviewing the branch; the rehearsal on a copy
(2026-11-08) backed up 41 tables / 8,937 rows, applied step 0041 and the M1 rename, and found no lost row.

## Next

M2: components and discovery (`src/<component>/` with `index.ts`, plugin registry into the runtime).
