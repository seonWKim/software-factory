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
- **CLI commands are discovered** (since 2026-11-08): each command is `src/cli/handlers/<command>/<command>.command.ts`
  (`defineCommand` from `src/cli/command.ts`: its names, its block of the help text, `run`). `src/main.ts` only reads
  `--config`, finds the command by name and runs it; adding a command edits no central file. Help lists the
  commands by file order (alphabetical).
- **Plugins are found anywhere under `src/`** (since 2026-11-08): `src/plugins.ts` walks the whole code root for
  `*.plugin.ts` and `*.grant.ts`, so a component keeps its plugins in its own `plugins/` folder.
- **Legacy code moves into its component when it is rewritten** (since 2026-11-08, RFC 0015 M2 re-planned):
  `src/core/`, `src/impl/` and `src/interfaces/` stay where they are until the milestone that rebuilds them
  (inbound M4, controller M5, worker M6, outbound M7, identity and guards M9). Moving them first would rewrite
  every import twice. New component code that still calls legacy code is listed by
  `tests/architecture/dependency-direction.test.ts` as `component-imports-legacy`; those entries go as the
  legacy code goes.
- **Runs execute as journaled steps** (since 2026-11-08, RFC 0015 M6; decision changed: the worker now runs on the
  engine). The worker lives in `src/worker/`: `pool.ts` runs the worker loops, `runner.ts` claims a run and drives it,
  and each run kind is one discovered folder `src/worker/runs/<kind>/<kind>.run.ts` (`defineRunKind`: its named
  timeouts, whether the runner makes its folder, and its body). The runner names no kind. `ExecutionEngine`
  (`src/worker/engine/`) is a plugin kind, `plugins.engine`, default `journal` (docs/plugins/execution-engine.md):
  each step's result is stored in `worker_run_steps` and returned instead of running the step again, so a resumed
  run skips finished steps; results are JSON, and a step can save a partial result for the attempt that resumes it.
  Writes are fenced by `worker_runs.lease_token`.
  - Steps today: triage `run-agent`; review `run-agent`, `post-review`; implement `run-agent` (partial: the agent's
    session id, resumed when this host's runner still has it; result: the work and a G5-scanned git bundle of its
    commits in shared storage), `record-handoffs`, `push-branch`, `open-pr`. A run taken over after its agent step
    restores the commits from the bundle and runs no agent (`tests/worker-crash-resume.test.ts`, SQLite and MySQL);
    with no bundle (the commits did not scan clean) it fails `resume_lost` (infra) and is retried afresh. The local
    phases between steps (folder, preflight, sync, gates, checks) run again on a resume; they are safe to repeat.
    Update, resolve and improve runs have no journaled step yet and run again from the start.
  - Claims still go through the store's `claimRun` (coordination, claim pauses, one branch writer per item): the
    runner hands the leased run to the engine (`adopt`, which stamps `code_version` and `deadline_at`), and the
    engine renews the lease on each heartbeat with the live `lease_ms` and aborts the run when it is lost. A run
    journaled by another `code_version` fails `not_resumable` (infra) and its retry is a new run. Each process
    stamps `dev` until compose passes its revision (`WorkerDeps.code_version`).
  - Named timeouts per run kind (`timeouts` in the kind file): `start_to_close` one hour per step (above the agent's
    own `run_timeout_ms`, which fires first), `heartbeat` the default `lease_ms`, `schedule_to_close` a week from
    the run's creation (runs wait in claim pauses and coordination holds). A step over its timeout fails
    `start_to_close` (infra); a run past its deadline fails `schedule_to_close`.
  - Takeover is still the controller's reaper: it requeues a run whose lease expired, and the next claim resumes it
    from the journal. The engine's own `reaper` tick (takeover in place, deadline failing) is not attached in the
    worker until the controller's reaper unit (M5) stops requeueing expired runs; two takeover paths would race.
  - Time: the engine moves only on ticks the runner gives it (the claim and each heartbeat). The runner's waits
    (idle claim loop, heartbeat interval, pause watch, the implement diff watch, the host-sleep check) still sleep
    on the injected Clock, which reaches the worker through the legacy `WorkerDeps` (`src/core/worker-deps.ts`, so
    `src/worker/` imports no clock); they move onto a TickGenerator in a later step.
  - Pushes, PR writes and review comments stay in the worker as journaled steps until outbound takes them (M7).
- **The sql bus** (since 2026-11-08, RFC 0015 M3; `src/bus/`, contract in `tests/bus-contract.test.ts` on SQLite
  and MySQL). A component publishes by writing its `<component>_outbox` in its own transaction; the relay moves
  the rows to the topic on the component's `relay` tick. Each topic has its own tables (`bus_<topic>`,
  `_cursors`, `_retries`, `_dead_letters`), created from the discovered topic descriptor by `ensureTopicTables`
  (never altered or dropped there) and listed in `bus_topics`; a change of a topic's partitions or consumption is
  refused and needs a bus migration. Partitioned and fan-out topics hand out one message per partition at a time
  under a lease, in order; a failed message holds its partition until it succeeds or is dead-lettered. Competing
  topics claim per row. Time on the bus is the release horizon in `bus_scheduler`, which only the retry
  scheduler's tick moves: retries, delayed messages and expired leases become due against it, so no consumer
  reads a clock. A delayed message on a partitioned topic is parked and does not hold up its partition. Consumers
  dedupe in their component's `<component>_inbox` in the same transaction as their effect (`deliver()`), so
  at-least-once delivery has an effect exactly once. Solo: SQLite, one process runs every schedule. Enterprise:
  MySQL, any number of consumers and schedulers; leases and claim tokens keep a message with one consumer.
- **Intake runs in inbound, on the bus** (since 2026-11-08, RFC 0015 M4; strangler: the legacy controller still
  decides). `src/inbound/` polls the sources, then the forge (whose records are stored first, so a merge is
  handled before the issue close it caused), relays stream records and command rows, and prunes old records. Each
  record and its `InboundReceived` message are written in one transaction with the fenced cursor move. The
  `normalize-source` handler turns it into `CommandReceived{command_id}` or `SourceEventReceived{record_id, kind}`
  on `controller.commands`; the controller's `legacy-controller` handler hands each to the old decision code
  (`consumeEvent`, `consumeCommand`). Both topics (`inbound.records`, `controller.commands`) are partitioned by
  stream (the source type, `local` for CLI and UI commands), so one source's records keep their poll order.
  The bridge runs the old code first and writes the inbox row after it (the old code commits its own writes and
  SQLite cannot nest transactions): at-least-once, safe because those handlers may run twice. A failed command is
  retried, never skipped: `controller.commands` backs off 1 s to 60 s for 1,000 attempts (about 16 hours) before a
  dead letter, which keeps the old hold-until-it-succeeds. The CLI command log and the app requests are one table,
  `inbound_commands` (breaking migration with verify and `legacy_*` copies; ids `cmd_<table>_<seq>`, every
  idempotency key kept). The controller role (`src/runtime/roles/controller-role.ts`) owns the sync lease and hands
  it to inbound (fences its cursor moves) and to the old controller (fences its deliveries). In production, relay
  and consume run every 250 ms and intake every `tick_ms`, so a command reaches the decision code up to about
  0.5 s later than in the old same-tick loop. `npm run migrate` creates every discovered topic's tables, so an
  enterprise MySQL user needs no DDL rights at run time; a role creates them again at start (idempotent), so solo
  needs no migrate step.
- **Run roles declare a Rule of Two profile** (since 2026-11-08, RFC 0015 M10). Each agent run kind (`triage`,
  `implement`, `review`, `resolve`) is one `src/worker/roles/<name>.role.ts` (`defineRole`, `src/shared/role.ts`): its
  prompt, tools, whether it is autonomous, its three facts (`untrusted_input`, `sensitive_access`,
  `external_effect`; classified strictly), what it proposes and approves, and its minimum golden cases. An autonomous
  role may not hold all three facts; `implement` and `resolve` hold them and are not autonomous, so
  `ruleOfTwoRefusal` refuses them unless a person approved their input. No role approves what it proposes, and no
  principal approves its own proposal (`approvalRefusal`). A golden case names its role in `case.json` (`role`; none
  means `review`). `src/worker/roles/` is on the gate list, so a role's facts change only by an owner merge
  (`tests/architecture/rule-of-two.test.ts`; triage, implement and resolve have no golden cases yet, listed in its
  ratchet). Not wired into the run path yet: the worker still picks prompts and tools itself (M6), and auto mode does
  not call `ruleOfTwoRefusal` (owner decision pending).
- **Hooks veto or annotate, never approve** (since 2026-11-08, RFC 0015 M10). A hook is
  `src/<component>/hooks/<name>/<name>.hook.ts` (`defineHook`, `src/shared/hook.ts`) at one point (`before_merge`,
  `before_run`, `before_delivery`) with a budget of at most 10 s. `runHooks` (`src/runtime/hooks/`, on the gate list)
  runs only after the guards allowed the action: a guard's refusal stands and no hook runs. Each enabled hook of the
  point runs in name order; a veto, a hook over its budget (`hook_timeout`) or one that throws (`hook_error`)
  refuses the action (fail closed); a note is passed on. Every decision is a `runtime_hook_decisions` row (ids only,
  text at most 200 characters; migration `20261108T2310-runtime-hook-decisions`). Solo and enterprise: no hook runs
  until the owner enables it; the caller passes the enabled names. Not wired yet: no call site (merge queue M8, run
  start M6, outbound M7) and no stored enable setting; no hook ships.
- **Architecture rules are tests** (since 2026-11-08): `tests/architecture/` with a ratchet of today's
  violations in `known-violations/*.json`, which may only shrink.

## History

- **Table names and schema steps** (decision changed 2026-11-08, RFC 0015 M1). Before: unprefixed tables shared
  by every part of the code, schema changes appended to SQLite's numbered list and to `migrations/mysql/`
  (still in force for steps up to `0041`, see 05-coordination.md "MySQL schema steps").
- **CLI commands** (decision changed 2026-11-08, RFC 0015 M2). Before: `src/main.ts` held one `switch` case per
  command and one hand-written help text.
- **Plugin discovery root** (decision changed 2026-11-08, RFC 0015 M2). Before: only `src/impl/` was walked.
- **Messaging between parts** (decision changed 2026-11-08, RFC 0015 M3). Before: no bus; the controller tick
  polls sources and the store, and workers claim runs from the store (still how the factory runs until components
  are wired to the bus in M4 and later).
- **Intake** (decision changed 2026-11-08, RFC 0015 M4). Before: the controller tick polled every source and the
  forge, read the command inbox and the app requests (two tables) by `seq` cursor, and handled each in the same
  tick.
- **Runs and the worker** (decision changed 2026-11-08, RFC 0015 M6). Before: the engine existed only in its
  contract test; runs went through `src/core/worker.ts` (one class, every kind a method, a dispatch by kind), which
  renewed its lease through the store's heartbeat and kept no journal, so a run whose worker died started over.
