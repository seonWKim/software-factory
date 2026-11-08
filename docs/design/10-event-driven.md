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
- **The bus and the tick generator are plugins** (decision changed 2026-11-08, M3 leftovers; see History).
  `plugins.bus` (EventBus, default `sql`, docs/plugins/event-bus.md) and `plugins.ticks` (TickGenerator, default
  `time-based`, `manual` for tests, docs/plugins/tick-generator.md) are chosen in `factory.config.json`; compose
  builds both through the plugin registry and hands them to the controller role, which builds each component's bus
  (`BusPlugin.component`), the retry scheduler (`BusPlugin.scheduler`) and each component's generator
  (`TickSource.create`) from them. A role built without them (tests) gets the defaults. The descriptors sit in
  `src/impl/bus/` and `src/impl/ticks/` until `plugin-api.ts` is a component: a component file importing it would be
  a new dependency-direction violation.
- **Competing topics filter by `requires`** (since 2026-11-08, M3 leftovers). A competing topic's `requires(m)`
  lists `key=value` requirements (e.g. `sandbox=docker`); the sql bus stores them sorted, as JSON, in the topic's
  `requires` column (migration `20261109T0100-bus-competing-requires` adds it to competing topics created before).
  A consumer's bus is built with `capabilities`, and it claims only a message whose requirements are all among them,
  filtered in SQL so unclaimable rows never fill a batch; a message that requires nothing goes to any consumer. A
  partitioned topic refuses `requires` (its owner must take every message in order). A requirement that is not
  `key=value` fails at publish. Solo and enterprise: the same; a worker declares what its sandbox and models can do.
- **Dead letters raise an alarm** (since 2026-11-08, M3 leftovers). The bus declares `system.alerts` (fan-out,
  90 days, partitioned by alert pattern) and writes a `DeadLettered` notice there in the transaction that
  dead-letters a message: topic, group, seq, message type, attempts, error code and the last error (at most 200
  characters). A dead notice raises none. The controller's `dead-letter-alarm` handler stores it as a `dead_letter`
  alert, one per dead letter (keyed by topic, group and seq; kept as long as the notice), its detail egress-scanned
  (G5), so Needs you shows it for the alarm window with the topic and the cause. No CLI replays a dead letter yet
  (`SqlRetryScheduler.replay` exists), and the router does not yet mark the actor `blocked_on: dead_letter` (M5).
- **Intake runs in inbound, on the bus** (since 2026-11-08, RFC 0015 M4; strangler: the legacy controller still
  decides). `src/inbound/` polls the sources, then the forge (whose records are stored first, so a merge is
  handled before the issue close it caused), relays stream records and command rows, and prunes old records. Each
  record and its `InboundReceived` message are written in one transaction with the fenced cursor move. The
  `normalize-source` handler turns it into `CommandReceived{command_id}` or `SourceEventReceived{record_id, kind}`
  on `controller.commands`; the controller's `legacy-controller` handler hands each to the controller role
  (`consumeEvent`, `consumeCommand`), whose router gives it to its unit (M5). Both topics (`inbound.records`, `controller.commands`) are partitioned by
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
- **The controller decides in discovered units** (since 2026-11-08, RFC 0015 M5; the units still do their own I/O).
  `src/core/controller.ts` is gone. Each feature is one unit, `src/controller/units/<unit>/<unit>.unit.ts`
  (`defineUnit`, `src/controller/router/unit.ts`), found by discovery: the event kinds it decides on (exactly one
  unit per kind), its steps on the controller's tick, and its operations. Today's units: `intake`, `commands`,
  `phases`, `closes`, `standing`, `verdicts`, `pr-events`, `run-results`, `checks-gate`, `coordination`,
  `merge-check`, `alarms`, `mirror`, `app-requests`, `local-merge`, `reaper`, `model-probe`, `improve`, `sync`,
  `auth`, `transitions` and `outbox` (the thread outbox, until M7 moves it to outbound). The router
  (`src/controller/router/router.ts`) names no unit: it hands each event to the unit that accepts its kind and runs
  the steps of a tick in their `order`, each guarded so one failing step never stops the others. A unit calls
  another unit's operation through `ctx.unit(name)`, typed by the `UnitOperations` interface each unit file
  extends, so no unit imports another; this is for what a message would be overkill for (a shared reply, a
  transition, a check another decision needs now). What all units share is the `Kernel` (`units/kernel.ts`: the
  deps, the configured sources and forge, the live settings, the step guard); declarations two or more units use
  are in `units/support.ts`. Every decided stage change is checked against the WorkItem state table
  (`transitions.inTable`); a move not in the table is refused with a warning. Solo and enterprise: unchanged; each
  replica runs every unit, and every write is still a conditional update.
- **Pure units: load, decide, the router commits** (decision changed 2026-11-08, M5 follow-up; see History). A
  step or event may be split in two (`PureStep`, `PureEvent` in `src/controller/router/unit.ts`): `load(…, reader,
  tick)` reads what the decision needs through the kernel's read-only accessors (`Kernel.reader`: named store reads
  and the egress scan, nothing that writes), and `decide(…, loaded, tick)` returns a `UnitDecision`, the writes to
  commit, with no I/O and no clock. The router runs both and hands the decision to `Kernel.commit`, which applies
  the writes in order (`ControllerWrite`: a thread entry, a CLI mirror mark, the lease expiry, a log line). Each
  write is one keyed or conditional store write, so committing a decision twice changes nothing the first commit
  did; the writes of one decision are not one transaction yet. An item decision ends in `Kernel.commitItem`: its
  keyed writes first (the budget checkpoint comment), then the conditional transition or budget checkpoint at the
  version it was decided on, and a version conflict is decided again. `threadEntry` (`units/kernel.ts`) is where a
  pure unit's factory message gets its delivery (the outbox unit's `post` decides the same way until M7 moves it).
  The units' steps run on one `decide` schedule each `tick_ms` of a TickGenerator over the injected `Clock`
  (`TickSource.create(onError, time)`; the time-based plugin reads and sleeps on `time` when given), so FakeClock
  tests move them by hand as before; `poll` steps run with the `tick` steps once `poll_interval_ms` passed by the
  tick's time. `tick_ms` is read when the loop starts (before: each pass). Pure today: `reaper` (its time is the
  tick's), `mirror`, and `transitions` (its re-read and budget reads go through the reader, its budget hold is a
  pure function of them, its writes through `commitItem`; its follow-ups, the status labels and the auto stop, are
  still other units' operations). `tests/architecture/unit-purity.test.ts` lists the rest, and the list only
  shrinks. Order for the rest: leaves before their callers. `run-results`, `commands`, `app-requests`, `verdicts`,
  `standing` and `intake` post through `outbox.comment`/`post` and ask `auth`, `checks-gate`, `standing` and
  `local-merge` inline, so they become pure only once those operations are writes and reads (`outbox` after M7,
  `checks-gate`/`local-merge` after M8). The `legacy-controller` bridge keeps "inbox row after the effect" for
  every message: no message it carries is exactly-once yet, since `commands` and the event units are not pure.
  Solo and enterprise: the same; each replica runs every unit.
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
- **Building the bus** (decision changed 2026-11-08, M3 leftovers). Before: the controller role constructed
  `SqlEventBus`, `SqlRetryScheduler` and `TimeBasedTickGenerator` itself, with no config choice.
- **Controller decisions** (decision changed 2026-11-08, RFC 0015 M5). Before: one `Controller` class in
  `src/core/controller.ts` (4,790 lines) held every decision, dispatched events with a `switch` on their kind, and
  ran its steps in one hand-ordered loop; the controller role extended it.
- **Pure units** (decision changed 2026-11-08, M5 follow-up). Before: every unit read and wrote the store inline;
  the units' loop slept on the injected `Clock` in a `while` loop, and the reaper read `clock.now()` itself.
- **Intake** (decision changed 2026-11-08, RFC 0015 M4). Before: the controller tick polled every source and the
  forge, read the command inbox and the app requests (two tables) by `seq` cursor, and handled each in the same
  tick.
- **Runs and the worker** (decision changed 2026-11-08, RFC 0015 M6). Before: the engine existed only in its
  contract test; runs went through `src/core/worker.ts` (one class, every kind a method, a dispatch by kind), which
  renewed its lease through the store's heartbeat and kept no journal, so a run whose worker died started over.
