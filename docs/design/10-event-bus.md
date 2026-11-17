# 10. Event-driven factory: the bus, inbound and the controller

- **The sql bus** (since 2026-11-08, RFC 0015 M3; `src/bus/`, contract in `tests/bus-contract.test.ts`). A component publishes by writing its `<component>_outbox` in its own transaction; the relay moves
  the rows to the topic on the component's `relay` tick. Each topic has its own tables (`bus_<topic>`,
  `_cursors`, `_retries`, `_dead_letters`), created from the discovered topic descriptor by `ensureTopicTables`
  (never altered or dropped there) and listed in `bus_topics`; a change of a topic's partitions or consumption is
  refused and needs a bus migration. Partitioned and fan-out topics hand out one message per partition at a time
  under a lease, in order; a failed message holds its partition until it succeeds or is dead-lettered. Competing
  topics claim per row. Time on the bus is the release horizon in `bus_scheduler`, which only the retry
  scheduler's tick moves: retries, delayed messages and expired leases become due against it, so no consumer
  reads a clock. A delayed message on a partitioned topic is parked and does not hold up its partition. Consumers
  dedupe in their component's `<component>_inbox` in the same transaction as their effect (`deliver()`), so
  at-least-once delivery has an effect exactly once. SQLite: one process runs every schedule; leases and
  claim tokens keep a message with one consumer.
- **Seq cursors never pass an uncommitted seq** (since 2026-11-09, RFC 0015 review; decision changed: writers to
  one sequence now commit in seq order, see History). Every insert
  into a sequence a cursor reads takes that sequence's lock row FOR UPDATE first, in the inserting transaction:
  the topic's `bus_topics` row for a topic table (the relay locks all its batch's topics in one statement, in key
  order, so two relays never deadlock; a dead-letter notice locks `system.alerts`), the `commands` row of
  `inbound_sequence_locks` for `inbound_commands` (CLI, UI and comment commands, migration
  `20261109T1015-inbound-sequence-locks`), and the listener's lease row per source type for a stream source's
  `inbound_raw_records` (already so). Readers stay plain reads. Chosen over a high-water mark (the lowest seq still
  in flight, or a settle delay), which needs either a vendor-specific query of open transactions or a delay on every
  message; the lock costs one indexed read per writing transaction and serializes only writers to the same
  sequence. SQLite has one writer, so the lock is skipped there.
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
  History). `insertOrSkip` is `ON CONFLICT DO NOTHING`, so a value too long for its column fails instead of being cut, and
  the inbox tells a duplicate from a new key by its row count. `envelopeProblems` refuses an id, type, subject, project, idempotency key, causation,
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
  0.5 s later than in the old same-tick loop. `npm run migrate` creates every discovered topic's tables, so at start a role creates only the tables of a topic
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

- Replaced decisions of this topic: [history/10-event-bus.md](history/10-event-bus.md).
