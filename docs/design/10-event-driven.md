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
- **Contract migrations run only on `npm run migrate -- --contract`** (since 2026-11-09, RFC 0015 M11; see
  History). A `contract` migration names the breaking migrations it follows (`after`) and is never pending for an
  open, a start or an update: SQLite's open and MySQL's `npm run migrate` skip it. `--contract` applies each one
  whose `after` migrations were applied at least 14 days earlier (`CONTRACT_MIN_DAYS`, the D9 down path's window)
  and prints why it skips the others; a table with rows is archived to `db/backups/` first, and with no backup
  folder the drop is refused (D4). Written: `20261109T0900-state-drop-legacy-tables` (M1's `legacy_*`) and
  `20261109T0901-inbound-drop-legacy-commands` (M4's). Solo and enterprise: the same; on a shared MySQL store the
  owner runs it once.
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
  - Steps today: triage `run-agent`; review `run-agent`, `post-review`; implement `run-agent` (an interrupted agent
    step starts a new session, since its retry has a new folder without the old session's commits; result: the work and a G5-scanned git bundle of its
    commits in shared storage), `record-handoffs`, `push-branch`, `open-pr`. A run taken over after its agent step
    restores the commits from the bundle and runs no agent (`tests/worker-crash-resume.test.ts`, SQLite and MySQL);
    with no bundle (the commits did not scan clean) it fails `resume_lost` (infra) and is retried afresh. The local
    phases between steps (folder, preflight, sync, gates, checks) run again on a resume; they are safe to repeat.
    Resolve: one `resolve` step (merge, agent, scope and marker gates, the merge commit, install and checks; three
    hours) whose result carries a G5-scanned bundle of the merge commit (`src/worker/bundle.ts`, shared with
    implement): a run taken over before its push restores that exact commit and pushes it, with no agent and no
    gate again; with no bundle it fails `resume_lost`. Update and improve runs have no journaled step yet and run
    again from the start: update's only effects are its push and PR comments, whose steps come with the worker half
    of M7 (outbound).
  - Claims still go through the store's `claimRun` (coordination, claim pauses, one branch writer per item): the
    runner hands the leased run to the engine (`adopt`, which stamps `code_version` and `deadline_at`), and the
    engine renews the lease on each heartbeat with the live `lease_ms` and aborts the run when it is lost. A run
    with a succeeded step journaled by another `code_version` fails `not_resumable` (infra) and its retry is a new
    run; failed or running rows hold only a partial, so a paused or requeued run whose steps all failed survives a
    deploy with its WIP (decision changed 2026-11-09, worker review finding 4; see History). Each process
    stamps the revision its supervisor built it from (`SF_CODE_VERSION`, 08-self-update), or `dev` unsupervised.
  - Named timeouts per run kind (`timeouts` in the kind file): `start_to_close` one hour per step (above the agent's
    own `run_timeout_ms`, which fires first), `heartbeat` the default `lease_ms`, `schedule_to_close` a week from
    the run's creation (runs wait in claim pauses and coordination holds). A step over its timeout fails
    `start_to_close` (infra); a run past its deadline fails `schedule_to_close`. Either one stops the step's work:
    the step's abort also aborts the signal the runner hands the run kind, and a failed step settles only after its
    work has, so the run's folder is never removed under a running agent (decision changed 2026-11-09, worker review
    finding 3; see History).
  - **One takeover path: the controller's reaper** (decision changed 2026-11-08, M6 leftovers; see History). The
    `reaper` unit requeues a run whose lease expired (with the retry backoff, `max_attempts`, a closed item's run
    cancelled, an interactive session failed `session_lost`, the attempt record closed), and the next claim resumes
    it from the journal. The engine has no reaper and no takeover of its own (`reap`, `attach` and `onTakeover` are
    gone): an engine taking runs over in place would race the reaper for the same run and skip every one of those
    rules. A run past its `schedule_to_close` deadline is aborted by its worker's heartbeat, or refused at its next
    step after a claim, and the worker fails it `schedule_to_close`.
  - Time: the engine moves only on ticks the runner gives it (the claim and each heartbeat). Every wait of the
    runner is a schedule on its TickGenerator (`plugins.ticks`, over the injected Clock, so FakeClock tests move
    them): `claim` (the idle loop, live `tick_ms`), and per run `heartbeat` (live `heartbeat_ms`), `pause-watch` and
    the implement agent step's `diff-watch`. A schedule's first tick is its start (the watches skip it); a later
    tick's `due` against its `now` is the host-sleep check (05-coordination, Host sleep).
  - A run's comments are thread entries outbound delivers (M7, worker half). Pushes and PR writes stay in the worker
    as journaled steps until outbound's `github-push` and `github-change` take them (see "Writes to the outside
    world leave through outbound").
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
- **Seq cursors never pass an uncommitted seq** (since 2026-11-09, RFC 0015 review; decision changed: writers to
  one sequence now commit in seq order, see History). MySQL assigns AUTO_INCREMENT at insert, not at commit, so a
  reader's `seq > cursor` could pass a lower seq whose transaction commits later and skip it for good. Every insert
  into a sequence a cursor reads takes that sequence's lock row FOR UPDATE first, in the inserting transaction:
  the topic's `bus_topics` row for a topic table (the relay locks all its batch's topics in one statement, in key
  order, so two relays never deadlock; a dead-letter notice locks `system.alerts`), the `commands` row of
  `inbound_sequence_locks` for `inbound_commands` (CLI, UI and comment commands, migration
  `20261109T1015-inbound-sequence-locks`), and the listener's lease row per source type for a stream source's
  `inbound_raw_records` (already so). Readers stay plain reads. Chosen over a high-water mark (the lowest seq still
  in flight, or a settle delay), which needs either a vendor-specific query of open transactions or a delay on every
  message; the lock costs one indexed read per writing transaction and serializes only writers to the same
  sequence. Solo: SQLite has one writer, so the lock is skipped there. Enterprise: MySQL replicas and components
  write one topic one transaction at a time.
- **Leases are renewed right before handling** (since 2026-11-09, RFC 0015 review). `consume` leases up to one
  message per partition (or `max` competing rows) at once, and the consumer handles them in order, so a later one's
  lease could run out while earlier ones are handled and a second replica would take it too. `EventBus.renew(c)`
  extends the lease from the horizon only while it is still that claim's and has not run out; the component
  consumer calls it before each `handle` and skips a message whose renew is refused (the new holder handles it).
- **A consumer group starts at an explicit position** (since 2026-11-09, RFC 0015 review; decision changed: a new
  group no longer starts at seq 0, see History). `EventBus.subscribe(group, topic, from)` registers a group on a
  partitioned or fan-out topic: `latest` (the default) starts each partition after its highest seq at that call,
  `earliest` before the first message the topic still holds; a group that has cursors keeps them, whatever is
  asked. A handler opts in with `startFrom: "earliest"` on its descriptor (none does today). "Latest" is taken when
  the group subscribes, not at its first consume: the controller role subscribes every handler when it wires its
  components, before any of them relays, so a message published after the process starts (a startup command, a
  first poll) is delivered, and a handler added later skips only what was published before its first start.
  The role consumes only inbound's, the controller's and outbound's handlers, so startup refuses a handler in any
  other component (since 2026-11-09): no group would subscribe it and its messages would pile up unread. A failed
  wiring or discovery (a transient store error) is not cached: the next call builds it again.
  `consume` refuses a group that never subscribed. Competing topics are one queue for every group: nothing to
  register. Solo and enterprise: the same; on a fresh store every topic is empty, so latest equals earliest.
- **Inserts skip key conflicts only** (since 2026-11-09, RFC 0015 review; decision changed: no `INSERT IGNORE`, see
  History). `insertOrSkip` is `ON CONFLICT DO NOTHING` on SQLite and a plain INSERT whose duplicate-key error is
  caught on MySQL, so a value too long for its column fails instead of being cut. Not `ON DUPLICATE KEY UPDATE pk =
  pk`: under the driver's `FOUND_ROWS` flag its row count is 1 for a skip too, and the inbox needs to tell a
  duplicate from a new key. `envelopeProblems` refuses an id, type, subject, project, idempotency key, causation,
  correlation, passport or producer longer than 191 characters, and the bus a partition key longer than that, at
  publish (never in the relay, which would stall the outbox).
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
  enterprise MySQL user needs no DDL rights at run time: at start a role creates only the tables of a topic
  `bus_topics` does not list yet (the row is written after the tables) and runs no DDL when every topic is listed
  (since 2026-11-09), so solo needs no migrate step.
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
  replica runs every unit, and every write is still a conditional update. Startup checks (since 2026-11-08, M8
  leftovers): every source and forge event kind is in a type-checked list (`CONTROLLER_EVENT_KINDS`,
  `units/context.ts`), and the router refuses to start when a kind has no unit (it was dropped at dispatch before)
  or a message type of `controller.events` has none; the worker pool refuses to start when a run kind it claims has
  no run file (`runKindProblems`; before, each such run failed only when claimed). Units emit bus messages: an
  `emit` write (or `Kernel.emit` from a unit that still writes inline) publishes on the controller's bus, delayed
  until the draft's `not_before`, on `controller.events`; the `unit-messages` handler hands each back to the unit
  that names its type under `messages` in its unit file.
- **Pure units: load, decide, the router commits** (decision changed 2026-11-09, M5 follow-up: one reply path,
  more units read through the reader and write through the kernel, `tick_ms` live again; see History). A step or
  event may be split in two (`PureStep`, `PureEvent` in `src/controller/router/unit.ts`): `load(…, reader, tick)`
  reads what the decision needs through the kernel's read-only accessors (`Kernel.reader`: named store reads, the
  egress scan, the forge's PR check reads, the command suggester and the permission checks, none of which changes
  controller state; Identity audits each permission decision), and `decide(…, loaded, tick)` returns a
  `UnitDecision`, the writes to commit, with no I/O and no clock. The router runs both and hands the decision to
  `Kernel.commit`, which applies the writes in order (`ControllerWrite`: a thread entry, a delivered entry's link, a
  CLI mirror mark, an app request's mark, a standing rule or proposal, auto mode's stop, the lease expiry, a bus
  message, a log line; the lease expiry's `then` decides the log lines that follow from what it expired, so the
  reaper's lines are its own decision). Each write is one keyed or conditional store write, so committing a decision twice changes nothing the
  first commit did; the writes of one decision are not one transaction yet. An item decision ends in
  `Kernel.commitItem`: its keyed writes first (the budget checkpoint comment), then its one conditional write at the
  version it was decided on (a transition, a budget checkpoint, a budget answer, a coordination approval, a
  verdict), and a version conflict is decided again. Every factory message is a `threadEntry` write
  (`units/kernel.ts`, the one builder; the outbox unit's `post` and `comment` commit it the same way), and the URL of
  an earlier delivery of the same marker is read first (`deliveredUrl`). The units' steps run on one `decide`
  schedule each `tick_ms` of a TickGenerator over the injected `Clock` (`TickSource.create(onError, time)`; the
  time-based plugin reads and sleeps on `time` when given), so FakeClock tests move them by hand as before; `poll`
  steps run with the `tick` steps once `poll_interval_ms` passed by the tick's time. A schedule's period may be a
  function (`Period`), read again after each tick, so a changed `tick_ms` applies from the next tick. Split into
  load and decide today: `reaper` (its time is the tick's), `mirror`, and `transitions` (its re-read and budget
  reads go through the reader, its budget hold is a pure function of them, its writes through `commitItem`). Off
  the unit-purity ratchet but not split yet (every read through the reader, every write through `commit` or
  `commitItem`, but reads, other units' operations and writes still interleave in one method): `outbox`, `auth`,
  `checks-gate`, `run-results`, `commands`, `app-requests`, `standing`, `verdicts`, and `merge-check` (it still hands
  the store and the sandbox to its `MergeChecker`, which the ratchet's patterns do not see).
  `tests/architecture/unit-purity.test.ts` lists the rest, and the list only shrinks. `local-merge` reads through
  the reader and writes its merge and base push as outbound intents in the commit (the `intent` write); its conflict
  probe at entry and its red-main check are still sandbox effects. The `legacy-controller` bridge keeps "inbox row after the
  effect" for every message: no message it carries is exactly-once yet, since `commands` and the event units do not
  return one decision to commit with the inbox row. Solo and enterprise: the same; each replica runs every unit.
- **Writes to the outside world leave through outbound** (since 2026-11-09, RFC 0015 M7, controller half, the
  worker's comments and the implement run's push and PR; the resolve, update, wip and session pushes and the PR body
  refresh are still broker calls). Controller units store intents (thread
  entries in `outbound_intents`; status labels, 👀, issue closes and posts with no thread entry in
  `outbound_actions`) instead of calling a source or the forge. The outbox step announces them as
  `DeliveryRequested{commit_id, commit_count, destination, intent_ids, reply}` on `deliveries.requests`
  (partitioned by destination, `<kind>:<ref>`); `commit_id` is the announcing transaction, so every intent is
  announced once, also one written straight through the store. The `aggregate` handler batches per destination
  under the §15.1 rules (pure functions in `src/outbound/aggregator/batching.ts`): `auto` sends a commit at once,
  adds a 2 s debounce for a destination with 3+ deliveries in 60 s, widens the window up to `max_wait` (30 s) as the
  forge budget falls under 20%, and never delays a reply to a person; `max_messages` (10) caps a batch.
  `outbound.batching` in factory.config.json sets `mode` (`auto`, `commit`, `fixed`), `debounce_ms`, `max_wait_ms`
  and `max_messages` per destination kind or `*` (review-only; tests not about batching use `commit`). The flush
  (`outbound-flush` tick) sends each destination's oldest due batch, in order, and only for the destination kinds
  this process can write now (its adapters and the forge, the synced type only on the sync lease's holder), so
  batches no process here can send never crowd out the rest; they wait for a process that has the adapter. Every
  text is egress-scanned (G5) first: a flagged text is delivered once, under its marker, as a notice naming the
  rules only, never retried in any form, so the destination's later batches go on. A failed comment, close or post
  retries its whole batch with backoff (intents already delivered are skipped); a status label or 👀 failure is
  logged and not retried (best effort, as before). A join (a commit added to the destination's open batch inside
  its debounce) updates the batch only while it is still `open` and moves its claim token, so a flush that read
  the batch's intents before the join fails its claim and reads them again; a joined intent never ends in a sent
  batch unsent (decision changed 2026-11-09, outbound review finding 1; see History). A delivery the target
  refuses for good is given up (below). `DeliveryCompleted` on `deliveries.results` records delivered
  URLs (`delivery-results` handler). Changes in effect order: a reject or a split's close is recorded in the store
  first and lands on the issue with its batch, after the comment before it; a low forge budget may delay outbox
  delivery by up to `max_wait` (it no longer runs regardless of the budget). `tests/architecture/forge-writes.test.ts`
  finds any forge or source write outside outbound; its ratchet list is empty since sub-issue filing moved
  (2026-11-09), so a new one fails it.
  - Deliveries refused for good are given up (decision changed 2026-11-09, outbound review finding 6; see History).
    A target error with an HTTP 4xx status that is no rate limit (429, or a 403 with a wait), no timeout (408) and
    no credential refusal (401, which a new token fixes) is refused for good (`refusedForGood`): a deleted, moved or
    locked issue, an archived repo, a PR the forge rejects. On the batch's third attempt (`REFUSED_ATTEMPTS`) such
    an intent is given up: an action is delivered with outcome `failed` and its error, a thread entry is delivered
    with no link, the batch is sent, and the destination's next batch goes on. Each given-up intent publishes a
    `DeadLettered` notice on `system.alerts` with the batch's `DeliveryCompleted` (group `outbound`, the intent id
    as its seq, code `non_retryable`), so the controller's dead-letter alarm stores a `dead_letter` alert and Needs
    you shows it. A given-up `pr` or `push` turns its item's wait (`pr_pending`, `push_pending`) into
    `blocked_on: human`, `blocked_reason: delivery_failed`, with the action and the error in the transition's
    detail. An error with no status (an outage, a git push) is never given up: it retries until it goes through.
    Solo and enterprise: the same.
  - Keyed intents and the PR close (M7 worker half): an action may carry a key (`outbound_actions.intent_key`,
    unique when set; migration `20261109T0415-outbound-action-keys`), and recording it again stores nothing. The
    source close of an item with a PR records one `close_pr` action keyed `close_pr:<item>` (the comment's two
    texts, `{closer}` filled from the forge, and the marker); outbound's `github-change` target calls
    `Forge.closePr` and retries a failure with its batch's backoff, and on `DeliveryCompleted` the outbox unit
    clears the item's `pr_close_pending` (`closes.prClosed`). Before, the closes unit called `closePr` inline and
    retried on each source-close tick. Solo and enterprise: the same; the key keeps a replica's repeat from
    storing a second close.
  - A run's comments (decision changed 2026-11-09, M7 worker half; 05-sources.md "A run's comments are thread
    entries"): the gate, review and update comments are thread entries on the item, stored once per marker, which
    the outbox step announces like the controller's. The worker imports nothing of outbound: it writes the thread
    through the store and gets the forge's `prRef` (a pure function) from compose. A restart re-runs at most the
    step, whose entry is keyed by its marker, so it is delivered once. The broker's `github.comment` is gone.
  - An implement run's push and PR (decision changed 2026-11-09, M7 worker half; see History). The run's last
    trusted step, after the gates, is `git.store_branch` (`STORE_BRANCH`, both brokers): the broker's trusted-git
    checks and the G5 branch scan, then the run folder's HEAD written to a ref of this host's factory repo with git's
    local transport (`storeBranch` in `src/impl/broker/trusted-git.ts`), no remote, no credential. The `local`
    broker writes `refs/heads/<branch>` (unforced; the branch is the change, `forge: false`); the `github` broker
    writes the staging ref `refs/factory/outbound/<branch>` (forced: only runs write it and each push names its sha;
    outside `refs/heads/`, so no person's branch is touched), `forge: true`. The worker then records, through the
    store (`FactoryStore.recordRunIntent`, outbound's `recordAction`; the worker imports nothing of outbound), the
    action `push` keyed `push:<branch>:<sha>` and the action `pr` keyed `pr:<branch>:<run>` (title, body, labels,
    base, run id), both to the destination `git:<host>:<branch>`, so the PR waits behind the push in one destination
    order. The PR key names the run, not only the branch as decided before: each implement run's PR delivery is its
    own, so an implement loop that pushes no new head still gets a delivery for the controller to wait on, and the
    open PR's title and body follow each run (issue #229). The run's result carries `pr_pending: true` and the PR
    key (`pr_intent`); no PR number. Outbound's `github-push` calls `Forge.pushBranch` (the GitHub forge: one
    `ls-remote` to reconcile, a branch already at the sha is delivered with no push, then an unforced
    `git push --no-verify <sha>:refs/heads/<branch>` from the factory repo to its origin URL, the token only in the
    child's env through an inline credential helper; the forge plugin now gets the credentials, G1/G2: no agent and
    no worker sees them). `github-change` calls `Forge.openPr` (reconcile: the branch's open PR is updated, never a
    second opened; `src/impl/github/pull-requests.ts`) and records
    the PR number and link on the action row (`delivered_ref`, `delivered_url`; migration
    `20261109T1130-outbound-action-results`). The broker's `github.push_branch` and `github.open_pr` are gone. The PR's title, body and labels are egress-scanned there (G5); a
    flagged text opens the PR with the withheld notice only. The controller sets the item `blocked_on: outbound`,
    `blocked_reason: pr_pending` (stage stays `RUNNING`; `outbound` is a new `blocked_on` value, shown as its stage
    like `dependency`), and on `DeliveryCompleted` the outbox unit hands the delivered `pr` action to
    `run-results.prDelivered`, which, at the item's version and only while it waits, sets `REVIEW`, `change_ref`,
    `change_url` and queues the review as an implement result did (state change `pr_delivered`). A PR delivered
    before the run's result is applied (outbound ran first) is read by its key and applied with the result
    (`implemented`). One delivered while the result is decided (its `DeliveryCompleted` handler found the item not
    waiting yet and changed nothing) is read once more after the wait is written (`deliveredMeanwhile`), so the wait
    never misses it (decision changed 2026-11-09, outbound review finding 4; see History). Restart safety: the steps are journaled, the intents keyed, the targets reconcile, and a worker
    that lost its lease records nothing (`recordPushedHead` refuses it first). Failures: `network_unavailable`,
    `forge_auth`, `github_rate_limited` and `push_failed` from the push or the PR are delivery failures, the message
    starting with the class; outbound retries the batch with its backoff, and the failed batch holds its destination
    (later batches of the branch wait). Changed from the run-time behaviour: these no longer fail the run, keep a
    wip branch or pause claims (the implement preflight still pauses claims on `forge_auth`, a rate limit and the
    network, before any agent runs); a forge outage delays the PR instead of spending a run attempt. A failure of
    the store step itself still keeps the commits on the run's wip branch: `git.store_branch` of the wip branch,
    then a keyed `push` intent when the broker says `forge: true` (the run passport names that branch,
    `wip_branch`); a failed wip store is logged, as a failed wip push was. Which process flushes a push: see "Git
    destinations" below. The base push is the `local` target's (the merge queue, M8).
  - Sub-issue filing (decision changed 2026-11-09, M7; see History and 04-split-specs.md, "Phases are filed through
    outbound"). `/approve` on a split spec claims the filing and replies that it is queued; the phases unit records
    one keyed `file_sub_issue` action per phase (`file_sub_issue:<parent>:<phase>:<approving comment id>`, target
    the parent's source; title, body, marker, phase), one at a time: phase N+1's body names phase N's ref, so the
    phases unit (`advanceSplit`) records it on phase N's `DeliveryCompleted`, after taking phase N in as a work item
    from the action's `delivered_ref` and `delivered_url`. Targets: `github-issue` (`fileSubIssue` of the GitHub
    source, which reconciles by marker: the parent's sub-issues, then the newest labelled issues, so a retry after a
    lost response files no second issue), the `local` target (`LocalSource.fileSubIssue`, a ref derived from the
    marker, no network call), `source` for another adapter. The title and body are egress-scanned (a flagged one is
    filed as the withheld notice under its marker). A failure is the batch's retry with backoff, no longer a refused
    `/approve`; one refused for good is given up (above) and the parent waits `blocked_on: human`,
    `blocked_reason: delivery_failed`, with the dead-letter alarm; `/approve` again claims anew and files the rest
    under new keys. `advanceSplit` reads only the store, and the phase tick runs it for a parent still at
    `split_filing`, so a lost step or `DeliveryCompleted` resumes. Solo and enterprise: the same.
  - Update and resolve pushes, the PR body refresh, and the session's push and PR (decision changed 2026-11-09, M7
    rest; see History). They take the implement path: `git.store_branch`, then the keyed `push` intent and, for a
    PR text, the `pr` intent (`runPushIntents`, `src/core/worker-deps.ts`; the update and resolve runs' `pr` intent
    carries the body rebuilt from the last implement run's notes, so the refresh is the PR delivery, and with no
    stored notes only the push is recorded). The run's result carries `push_intent`. A refused store still fails the
    run (`push_failed`, the broker's code); a forge push failure is outbound's retry, no longer a failed run. The
    controller does not queue the review on a pushed update or resolve result while the push is undelivered: the
    item waits `blocked_on: outbound`, `blocked_reason: push_pending`, and on `DeliveryCompleted` of the `push`
    action (its `run_id`) `run-results.pushDelivered` sets `REVIEW` and queues the review keyed
    `<item>:review:after-<kind>:<run>` (state change `push_delivered`), so the review never reads the head before
    the push. A push delivered before the result is applied is applied with it. `factory session finish` stores
    the branch the same way and records `push` and `pr` (empty labels) to `git:<host>:<branch>`; the session's
    result carries `pr_pending` and `pr_intent`, and the controller waits on it as on an implement run's PR
    (`pr_pending`, `prDelivered`). Solo and enterprise: the same; the local broker returns `forge: false`, so a local
    item records no intent and waits on nothing.
  - Outbound's service passport (decision changed 2026-11-09, M7 rest / M9). Every delivery is `use_tool` on its
    target (`github-push`, `github-change`, ...) by `service:outbound` (`outboundServiceAuth`,
    `src/impl/auth/audited-auth.ts`; compose passes it as `outbound_auth`), decided and audited in `authz_audit`. A
    denied write is not sent: the batch fails with `passport_denied: <reason>` and retries with its backoff, so it
    goes out once the passport is allowed again. `DeliveryCompleted` carries the passport id. With no Identity (tests,
    a startup check) every delivery is allowed under no passport, as before. Solo and enterprise: the same.
- **Run roles declare a Rule of Two profile and drive the agent** (since 2026-11-08, RFC 0015 M10; decision changed
  in the M6 leftovers: roles now drive prompts and tools; changed 2026-11-09: every run start checks the Rule of Two,
  see History). Each agent run kind (`triage`,
  `implement`, `review`, `resolve`) is one `src/worker/roles/<name>.role.ts` (`defineRole`, `src/shared/role.ts`): its
  prompt, tools, whether it is autonomous, its three facts (`untrusted_input`, `sensitive_access`,
  `external_effect`; classified strictly), what it proposes and approves, and its minimum golden cases. An autonomous
  role may not hold all three facts; `implement` and `resolve` hold them and are not autonomous. **Every run start
  checks the Rule of Two** (owner decision 2026-11-09): every run the controller queues passes
  `TransitionsUnit.decide`, which asks `ruleOfTwoRefusal` before the budget check. A run whose role holds all three
  facts is queued only when a person approved the item: of its state changes, the decision being made included, the
  newest one by a person (`user` actor: `/approve`, `/retry`, `/resolve`, ...) or by auto mode (`system:auto`) is a
  person's (`personApproved`). Otherwise the run is held: the decision's other effects stand (an auto approval is
  still recorded as `spec_approved`), the item blocks with `blocked_on: human`, `blocked_reason: rule_of_two` (no new
  stage), the held run's kind, key, input and not-before go on that state change's detail (`held_by: rule_of_two`),
  and one comment says why and what to reply. A person's `/approve` (`rule_of_two_approved`, the person as actor, a
  note goes to the implementer as an approval note) queues the held run; `/reject` closes the item; other commands
  are refused. In auto mode, then, a spec auto mode approves still waits for a person before implement runs; auto
  mode's approval still answers the spec's decisions and its merge still applies. Manual mode is unchanged: it has no
  auto approval, so the dials, a standing rule and a parent's `phases_auto_approve` approval run as before. Solo and
  enterprise: the same; the person's command passes their passport check as any `/approve`. `src/shared/role.ts`
  joined `src/worker/roles/` on the gate list. No role approves what it proposes, and no
  principal approves its own proposal (`approvalRefusal`). A golden case names its role in `case.json` (`role`; none
  means `review`). `src/worker/roles/` is on the gate list, so a role's facts change only by an owner merge
  (`tests/architecture/rule-of-two.test.ts`; triage, implement and resolve have no golden cases yet, listed in its
  ratchet). Every agent step takes its system prompt (the role's file under `prompts/`) and its tools from its role
  (`Worker.roleSpec`; the run kind's role, or `resolve` for implement's conflict retry); a run kind names neither. A
  role whose prompt file is missing fails the run `prompt_missing` before the agent starts.
- **Hooks veto or annotate, never approve** (since 2026-11-08, RFC 0015 M10; decision changed in the M6 leftovers:
  `before_run` is called and the `hooks` setting enables them, see History). A hook is
  `src/<component>/hooks/<name>/<name>.hook.ts` (`defineHook`, `src/shared/hook.ts`) at one point (`before_merge`,
  `before_run`, `before_delivery`) with a budget of at most 10 s. `runHooks` (`src/runtime/hooks/`, on the gate list)
  runs only after the guards allowed the action: a guard's refusal stands and no hook runs. Each enabled hook of the
  point runs in name order; a veto, a hook over its budget (`hook_timeout`) or one that throws (`hook_error`)
  refuses the action (fail closed); a note is passed on. Every decision is a `runtime_hook_decisions` row (ids only,
  text at most 200 characters; migration `20261108T2310-runtime-hook-decisions`). Solo and enterprise: no hook runs
  until the owner lists it in `hooks` (factory.config.json, a PR-only key, so enabling one is a reviewed and
  audited change; startup fails on a name no discovered hook has). On a shared store `hooks` is a reviewed key,
  read only from the checked-in file like `dials` (since 2026-11-09), so a replica's own config cannot drop a veto. `before_run` is called at run start, after the
  guards (the claim and the run passport) allowed the run: a refusal fails the run `hook_refused` before its folder
  or agent; a note is logged. `before_merge` is called at the merge queue's landing (subject the work item): a veto
  removes the entry and posts the hook's reason. Not called yet: `before_delivery` (outbound), so startup refuses an
  enabled hook at that point (`UNCALLED_HOOK_POINTS`, `src/shared/hook.ts`; since 2026-11-09) until outbound calls
  it. No hook ships.
- **Commands and runs carry passports** (since 2026-11-08, RFC 0015 M9 wiring; details in 08-permissions.md,
  "Passports in the running factory"). A CLI or UI command row stores its actor's passport id; inbound mints one for
  a comment command at relay time, before its commit (a passport minted for a commit that loses its cursor race is
  never used), and puts it on `InboundReceived`, so `CommandReceived` inherits it as its cause's `passport_id`. The
  RFC puts this in the normalizer; it is at the relay because the normalizer runs inside the consumer's
  transaction, and Identity writes `identity_passports` on its own connection. A run passport is minted at run start
  and checked by the ToolBroker on every call. The controller decides a command under its passport (Identity checks
  it, the origin's auth plugin decides the role) and auto mode under its service passport; every decision is
  written to `authz_audit`.
- **The merge queue** (decision changed 2026-11-09, the landing is an outbound delivery; see History). A local change merges only through
  the `merge-queue` unit, one `MergeQueue` actor per project and base branch (state table
  `src/controller/actors/merge-queue/`, snapshots `controller_merge_queues` and `controller_merge_queue_entries`,
  migrations `20261109T0300-controller-merge-queue` and `20261109T1030-controller-merge-queue-heads`; each entry is
  a `MergeQueueEntry` actor; the queue id is a hash of project and base, so any length fits MySQL's key). Entry: only
  a ready change (merge_pending: reviewed, its own checks green) approved by `factory merge` / the Merge button (the
  approver role) or by auto mode where its tier allows, so a change waiting on a person is never in the queue. A
  branch that conflicts with the base is refused at once, as before. Check: each of the first `merge_queue.depth`
  entries gets a `merge-check` run (`src/worker/runs/merge-check/`, no agent, no push), all out at once, which merges
  the branches of the entries ahead of it and then its own onto the base in a fresh run folder, records each
  branch's head, and runs the install command and the checks there. `merge_queue.depth`
  (`src/controller/settings/merge-queue-depth.setting.ts`, PR only, 1 to 10): solo default 1 (RFC 0009),
  enterprise speculative depth N, 2 typical (RFC 0015 §7). A green check passes the entry (`passed`, with its
  `heads`); the head lands once it passed. Landing: for an automatic entry, auto mode and the controller's service
  passport are checked again (a person may have switched to manual, a stop condition fired); then the
  `before_merge` hooks (a veto removes the entry with the hook's reason); then the merge leaves through outbound
  (below), and it moves the base only while it is still at the commit the check expects (the checked base for an entry nothing was ahead of, else
  the commit the last entry ahead landed as, which that landing writes on every entry checked with it ahead) and the
  branch is still at the head its check merged. So the tree that lands is the tree that was checked and no check
  runs again; a moved base or a commit on the branch meanwhile sends the entry and every entry checked with it ahead
  back to be checked. Red main runs after the landing, once the queue is given back.
  - The landing as an outbound delivery (decision changed 2026-11-09, RFC 0015 M7/M8). `LocalMergeUnit.requestMerge`
    writes one `merge` action in the unit's commit (the kernel's `intent` write), keyed `merge:<entry>:<check run
    key>` (one per check, so an entry checked again after a moved base lands anew), to the destination
    `git:<host id>:<base>`, with the branch, the expected base and head, the commit message, the entry id and its check.
    Outbound's `local` target makes it through `LocalGit` (`src/outbound/targets/local-git.ts`, the target's
    dependency in `TargetDeps.git`, built from the sandbox the role holds; the sandbox's `mergeLocal` is the only git
    write) and records the outcome as the action's `delivered_ref`: merged (sha, already, checkouts not updated),
    moved (the base or the branch moved, also a base that moves while the merge runs, or they conflict now: the
    entry is checked again and the check names the conflicts) or refused. The queue stays `merging` until `DeliveryCompleted`: the outbox unit hands the delivered
    `merge` to `merge-queue.mergeDelivered`, which closes the item (`LocalMergeUnit.merged`; the close moved here
    from the landing), marks the entry merged and tells the entries behind it the commit it landed as, or sends it
    back, or removes it with the refusal; then gives the queue back and moves on. Only an entry still `merging` under
    that check changes, so a redelivered or late result changes nothing. A delivery that throws (a git lock, a full
    disk) is retried by outbound with its batch's backoff, holding the destination; the entry stays `merging`
    meanwhile and lands when the retry does. A merge written but not recorded delivered (a crash in the target) is
    delivered again and finds the branch in the base (`already`), so it lands once. The lease: not extended for
    outbound's delay; a takeover after `lease_ms` is safe instead because the request is keyed and the landing is a
    reconcile step: it finds the keyed action, requests nothing again, re-runs neither the auto-mode check nor the
    hooks, and applies the result itself when the action is delivered (a lost or failed DeliveryCompleted). A close
    that did not apply throws, so the delivery result is retried (the bus's nack) or the takeover applies it.
  - The base push (its own destination `git:<host id>:<base>:push`, after the merge; 05-sources.md "Base push";
    decision changed 2026-11-09, outbound review finding 3, see History). Not in one order with the merges: a
    remote that is down, a token that expired or a protected branch that refuses the push holds no later local
    landing; the key keeps the push at most once and each push syncs the remote base first, so pushes need no order
    with the merges. With a remote to push to (a
    forge with `pushBase` and a sandbox with `syncBase`), the delivered merge stores one `push_base` action keyed
    `push_base:<item>:<merge sha>` before the item's close, so a crash between them pushes once. The `local` target
    fetches the remote base, merges it into the local base when it moved, and has the forge push conditionally on
    the remote sha it read; a failure is a retried delivery; a remote base that conflicts is delivered as a conflict
    and posts one message on the closed item. The status page reads it through `FactoryStore.getBasePush` (the newest
    `push_base` action, its batch's failed tries). The `outbound_base_pushes` table and the outbox step's base push
    step are gone from the code; the table stays until the contract migration `20261109T1215-outbound-drop-base-pushes` drops it (`migrate --contract`). A row still pending
    there at the upgrade becomes the `push_base` action the merge would have stored, under its key, to the `local`
    host's base push destination (`git:local:<base>:push`, `20261109T1200-outbound-carry-base-pushes`; a migration
    knows no host id), which every controller flushes (below).
  - Git destinations (decision changed 2026-11-09, outbound review findings 2 and 5; see History). A git write
    (a run's push and PR, a landing, a base push) names the machine whose factory repo holds it by a stable host
    id, not `os.hostname()`: the state dir's `host-id` file (`src/runtime/host-id.ts`), written once (the short
    hostname then plus a random suffix, linked in place so two processes starting at once keep one) and read by the
    controller, the worker pool and `factory session` on that machine. A renamed laptop or a new network name
    orphans nothing. Tests and a process built without one use the host `local`. Solo default (one controller, the
    SQLite store, `gitHost(stateDir, "sqlite")`): the controller flushes every `git` destination whatever its host,
    so the merge and the push run where the factory repo is, with no setup, and a destination recorded under an
    older id is still sent; with no forge there is no push. Enterprise setting (several replicas on a shared store):
    each replica flushes its own host id's destinations (`git:<host id>`) and the `local` host's (the carried base
    pushes, which any replica pushed before), so a landing is made in the factory repo of the replica that took the
    queue, and its push follows from there; the merge queue's row serializes landings across replicas, the keyed
    actions and outbound's batch claim make each merge and push once. The branches of local items must be in that
    replica's factory repo (a shared factory repo, or one controller host), as before. A landing taken over by
    another replica whose merge targets the first replica's host waits for that host: it is not re-recorded for the
    new one, since the item's branch is in the first host's factory repo. Red, a failed check run, or a
  check that did not come back in time: the entry leaves with the reason posted on the item (which stays in
  merge_pending), every entry checked with it ahead is rebuilt (queued again), and the queue moves on. A result or
  timer moves an entry only while it is still on that run (`run_key` in the conditional update), so the result of
  a replaced check never passes the rebuilt entry. The time limit: starting a check emits a delayed
  `MergeCheckTimedOut{entry_id, run_key}` on `controller.events`, due after max_attempts × (run_timeout_ms +
  lease_ms + retry_max_ms), every attempt the reaper may give the run with its longest backoff. Crash safety: the
  timer is emitted before the entry moves to checking, and the run is queued after it; a checking entry whose run
  is missing gets it again on the next step. The queue is taken for a landing conditionally on its version and given
  back in a `finally`; a landing whose process died is taken over after `lease_ms`, and a head left `merging` (a
  throw) is landed again. `land` is safe to repeat: an item already closed by its merge is landed, a branch already
  in the base closes the item on that base, and a close that did not apply after the base moved throws so it is
  landed again. A result whose decision threw is not acked, so the next runs step decides it again. The leave step
  never removes a `merging` entry (its item closes as it lands). Queue states: `checking` while a check is out,
  `merging` while the head lands (nothing starts meanwhile). Every move is conditional on the state it leaves;
  entries of one queue are made one at a time (the queue row is locked). Auto mode tries once per passed review run
  (its key no longer names the item version, which the queue's state changes bump). Not built yet: a `paused`
  state (dropped until a command needs it; neither this design nor the RFC names one), cancelling a removed entry's
  queued check run (its result changes nothing; it only uses a worker), batches with bisect and partitions; the
  `github-change` merge delivery (the factory merges no PR today; a person merges it on the forge). The unit's I/O
  goes through the actor's store and `local-merge` (unit-purity follow-up).
- **Architecture rules are tests** (since 2026-11-08): `tests/architecture/` with a ratchet of today's
  violations in `known-violations/*.json`, which may only shrink.

## History

- **Rule of Two at run start** (decision changed 2026-11-09, owner decision). Before: `ruleOfTwoRefusal` existed but
  no run start called it, so an implement or resolve run started once its item was approved, by a person or by auto
  mode, and in auto mode they ran with all three facts and no person.
- **Sub-issue filing through outbound** (decision changed 2026-11-09, M7). Before: the phases unit called
  `fileSubIssue` inline, every phase in one `/approve` pass (the last `forge-writes` ratchet entry); a failure
  refused the approval and put the spec back at the gate, and a claim left by a stopped process could be taken over
  by `/approve` after 10 minutes.
- **Outbound review fixes** (decisions changed 2026-11-09). Before: a join updated the open batch with no state
  check and no claim-token move, so an intent joined between a flush's read and its claim ended in a sent batch
  unsent (finding 1); git destinations named `os.hostname()` (from the replica id, `local` with none), and a
  controller with a replica id, which compose always set, flushed only its own hostname's, so the carried base
  pushes on `git:local:` were never sent and a changed hostname orphaned pending git writes (findings 2, 5); a base
  push shared `git:<host>:<base>` with the merges, so a failing push held every later landing (finding 3); a PR or
  push delivered while the run's result was decided was missed and the item stayed `pr_pending` (finding 4); a
  retried delivery retried forever, holding its destination with only a warning (finding 6); a base that moved
  during a local merge came back `refused` and removed the entry (finding 7).
- **Pure units: load, decide, the router commits** (decision changed 2026-11-09, M5 follow-up). Before: the outbox
  unit's `post` built and wrote thread entries itself beside `threadEntry`, only `reaper`, `mirror` and
  `transitions` were off the ratchet, the reader held store reads and the scan only, and `tick_ms` was read once when
  the decide loop started.
- **Merging a local change** (decision changed 2026-11-08, RFC 0015 M8). Before: `factory merge` and auto mode
  merged at once in the controller's sandbox, running the install command and the checks on the merge commit; two
  changes approved together were each checked against the base alone (05-sources.md "Merge").
- **Merge queue depth and time limit** (decision changed 2026-11-08, M8 leftovers). Before: depth 1 only (one
  check out at a time, the queue row's `idle → checking` move as the lock), and a stuck check waited for its run's
  own timeouts and the reaper, since units could not emit a bus message.
- **Merge queue crash safety and the landed tree** (decision changed 2026-11-09, controller review fixes). Before:
  a throw or restart while the head landed left the queue `merging` for good; a crash between the move to checking
  and the run left an entry checking with no run or timer; a stale check's result could pass a rebuilt entry; the
  branch's current head landed, not the head that was checked; an automatic entry landed after auto mode was turned
  off; the time limit left out retry backoff; red main ran inside the landing; a `paused` state existed that nothing
  could set; the queue id was `mq:<project>:<base>` (too long for MySQL's key with a long project key).
- **The landing as an outbound delivery** (decision changed 2026-11-09, RFC 0015 M7/M8). Before: the landing called
  `LocalMergeUnit.land`, which merged in the controller's sandbox inline and closed the item in the same step, and
  gave the queue back in a `finally`; the base push was an `outbound_base_pushes` row written in the close
  transition and pushed by the outbox step's base push step (claim, backoff of its own).
- **Unhandled event kinds** (decision changed 2026-11-08, M8 leftovers). Before: the router dropped an event no unit
  accepted, and a run kind with no run file failed each of its runs when claimed.

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
- **Passports on commands and runs** (decision changed 2026-11-08, RFC 0015 M9 wiring). Before: every message
  had `passport_id` null, and no run held a passport.
- **Pure units** (decision changed 2026-11-08, M5 follow-up). Before: every unit read and wrote the store inline;
  the units' loop slept on the injected `Clock` in a `while` loop, and the reaper read `clock.now()` itself.
- **Intake** (decision changed 2026-11-08, RFC 0015 M4). Before: the controller tick polled every source and the
  forge, read the command inbox and the app requests (two tables) by `seq` cursor, and handled each in the same
  tick.
- **Runs and the worker** (decision changed 2026-11-08, RFC 0015 M6). Before: the engine existed only in its
  contract test; runs went through `src/core/worker.ts` (one class, every kind a method, a dispatch by kind), which
  renewed its lease through the store's heartbeat and kept no journal, so a run whose worker died started over.
- **Roles and hooks in the run path** (decision changed 2026-11-08, M6 leftovers). Before: each run kind passed its
  own system prompt and tool list, the role files only declared them; no hook point was called and nothing enabled
  a hook.
- **Takeover and the worker's waits** (decision changed 2026-11-08, M6 leftovers). Before: the engine had its own
  `reaper` tick (take a run over in place, fail runs past their deadline), not attached in the worker, beside the
  controller's reaper that requeued; and the runner's waits slept on the injected Clock in `while` loops.
- **Outbound writes** (decision changed 2026-11-09, RFC 0015 M7). Before: the controller's outbox step and its
  transitions called the sources and the forge directly (comments with retries, labels and 👀 best effort, closes
  inline), outside any batch, and outbox delivery never waited on the forge budget.
- **Seq cursors** (decision changed 2026-11-09, RFC 0015 review finding 1). Before: inserts into a topic table or
  `inbound_commands` took no lock, so on MySQL a cursor could pass a seq that committed later and lose it.
- **Start of a new consumer group** (decision changed 2026-11-09, review finding 6). Before: `consume` created a
  group's cursors at seq 0 on first use, so a new or renamed handler replayed the topic's whole retention.
- **Skipping duplicate rows** (decision changed 2026-11-09, review finding 7). Before: `INSERT IGNORE` on MySQL,
  which also hid values cut to their column.
- **Contract migrations** (decision changed 2026-11-09, RFC 0015 M11). Before: the runner applied every pending
  migration, a contract one too, on open (SQLite) and on `npm run migrate` (MySQL); none was written yet.
- **An implement run's push and PR** (decision changed 2026-11-09, RFC 0015 M7 worker half). Before: the implement
  run pushed its branch (`github.push_branch`) and opened or updated its PR (`github.open_pr`) through the broker in
  its own steps, returned the PR number in its result, and a push or PR failure failed the run, kept a wip branch and,
  for `forge_auth` or a rate limit, paused claims. The decision before the build keyed the PR intent `pr:<branch>`.
- **Update, resolve, wip and session pushes** (decision changed 2026-11-09, RFC 0015 M7 rest). Before: the update
  and resolve runs, the wip branch and `factory session finish` pushed through the broker's `github.push_branch`,
  the PR body refresh and the session's PR went through `github.open_pr`, a forge failure failed the run, and the
  review after an update or resolve was queued as soon as the result was applied.
- **Outbound's passport** (decision changed 2026-11-09, RFC 0015 M7 rest / M9). Before: outbound delivered under no
  passport and `DeliveryCompleted` carried `passport_id` null.
- **A run's comments** (decision changed 2026-11-09, RFC 0015 M7 worker half). Before: the worker posted its gate,
  review and update comments itself through the broker's `github.comment`, inside the run, and an update run failed
  when its comment failed.
- **Resume across a deploy** (decision changed 2026-11-09, worker review finding 4). Before: any journal row, a
  failed one included, made a run journaled by another `code_version` fail `not_resumable`, so a paused or
  network-requeued run lost its WIP on every deploy.
- **Stopping a timed-out step** (decision changed 2026-11-09, worker review finding 3). Before: a step timeout or
  the run deadline rejected the step but no run kind passed the step's signal to its work, so the agent kept
  running (and spending) in a folder the runner had already removed, beside the retry's agent.
- **An interrupted agent step starts a new session** (decision changed 2026-11-09, worker review finding 2). Before:
  the implement and review agent steps saved the session id as the step's partial result, and implement resumed it
  when this host's runner still had it. A network requeue or a restart gives the retry a new folder, so the agent
  was resumed in an empty folder and told its earlier work was there. A pause still resumes its session, in the
  folder it kept.
- **`hooks` on a shared store** (changed 2026-11-09, runtime review M1). Before: `hooks` was PR-only but not a
  reviewed key, so a MySQL replica started with its own `--config` took `hooks` from that file; `hooks: []` there
  skipped the owner's `before_merge` veto whenever that replica landed the merge queue.
- **An enabled `before_delivery` hook** (changed 2026-11-09, runtime review L1). Before: startup accepted it (the
  name was discovered) though nothing ran it, so every delivery went out unchecked with no error.
- **Topic tables at start** (changed 2026-11-09, runtime review M3). Before: every start ran each topic's
  `CREATE TABLE IF NOT EXISTS` even when `bus_topics` listed it, so a MySQL user without CREATE rights failed at the
  first `wire()` and the controller restarted in a loop.
- **Unconsumed handlers and failed builds** (changed 2026-11-09, runtime review L2, L3). Before: a handler in a
  component no role consumes (worker, identity) passed the dispatch check and its messages piled up with no
  error; and a failed `build()` or discovery stayed cached as a rejected promise, so every later call failed the
  same way for the life of the object.
