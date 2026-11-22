# 10. Event-driven factory (RFC 0015)

The factory is moving to independent, restartable actors that talk only through messages on a bus (RFC 0015,
kept outside the repo with the other RFCs). The RFC 0015 progress record, kept in the RFC repo with the
RFCs (outside this repository), holds the snapshot of the move; its open items are rows in `docs/architecture-open-items.md`.
This file holds the decisions already in
force.

## Current decisions

- **Every table carries its owner's prefix** (since 2026-11-08): `bus_`, `inbound_`, `controller_`, `worker_`,
  `outbound_`, `identity_`/`authz_`, `runtime_`, `ui_`, `ext_<name>_`. A component's code names only its own
  tables (`tests/architecture/table-ownership.test.ts`).
- **The generated table list is one file per owner prefix under `schema/sqlite/`** (decision changed 2026-11-22,
  issue #754; replaces "one generated `schema/sqlite.sql`", see History). Each prefix that has tables gets
  `schema/sqlite/<prefix>.sql` (`bus.sql`, `controller.sql`, `authz.sql`, ...) with every table and index of that
  owner; tables with no prefix are in `unprefixed.sql`. `npm run schema:snapshot` rewrites the files and removes any
  it no longer produces; `tests/architecture/schema-snapshot.test.ts` fails when one is stale, missing or extra.
  Reason: the one file was a path companion of every migration, so items for different owners held each other on
  it (5 held items in a week, no conflict runs). One file per table (about 104) would pass the file cap.
- **Schema changes are timestamped migrations** (since 2026-11-08): `<yyyymmddThhmm>-<component>-<slug>.migration.ts`
  in the owning component's `migrations/` folder, found by discovery, recorded in `runtime_schema_migrations`.
  They run after the frozen numbered baseline (the list in `src/impl/store/sqlite/schema.ts`), which gets no
  new entries. SQLite applies them when it opens, in the same transaction as the baseline.
- **No data moves in place** (since 2026-11-08). A breaking migration first writes every table it names to
  `backups/<time>-<id>/<table>.jsonl` with a manifest of row counts and checksums: beside the SQLite file. A fresh database is not backed up. Renames copy each table under its new
  name from its own DDL, verify every column of every row, and only then rename all old tables to
  `legacy_<old>` at once (one transaction). The legacy tables stay
  until a contract migration drops them after the owner confirms.
- **One contract migration copies missing `legacy_*` rows, then drops every `legacy_*` table** (decision changed
  2026-11-15: the legacy contract checks and copies before it drops, and `--contract --dry-run` exists; SQLite only;
  replaces "two contract migrations drop M1's and M4's `legacy_*` tables without checking", see History).
  Contract migrations run only on `npm run migrate -- --contract`: a `contract` migration names the breaking
  migrations it follows (`after`) and is never pending for an open, a start or an update: SQLite's open skips it.
  `--contract` applies each one whose `after` migrations were applied at least 14 days earlier (`CONTRACT_MIN_DAYS`,
  the D9 down path's window) and prints why it skips the others; a table with rows is archived to `db/backups/`
  first, and with no backup folder the drop is refused (D4). `--contract --dry-run` runs each ready one inside a
  savepoint that is rolled back: it prints the same report and changes, backs up and records nothing.
  `20261109T0900-state-drop-legacy-tables` is the only one for legacy tables. It follows M1's rename, M4's command
  merge and the change-ref rebuild (`20261112T1200`), finds every `legacy_*` table in `sqlite_master` and maps each
  to its current table (`LEGACY_TABLES`: the renames, both command tables into `inbound_commands` by `command_key`,
  the rebuilt controller tables, and four retired tables with no replacement whose rows are only archived). A legacy
  table missing from the map stops the run before anything is copied or dropped, and the error names it. Each row
  whose key is not in its current table is copied (parents before children), the copy is checked, then all legacy
  tables are dropped; it prints per table its rows, how many it copied (with each copied key) and how many it
  dropped. A rerun copies nothing twice, and a run stopped after its copies only drops. The frozen rename migrations
  still make `legacy_*` tables on a fresh replay, and `inbound_commands.legacy_table` / `legacy_seq` stay (row data
  the app request seq mapping and retention read). No runtime reader names a `legacy_*` table: the table docs and
  `HIDDEN_COLUMNS` list none, the Data page hides every value of a table no doc describes, and the Data page's Ask
  leaves such tables out of the model's request. `20261109T1215-outbound-drop-base-pushes` stays a separate contract.
- **Rehearse before migrating** (since 2026-11-08): `npm run migrate -- --rehearse` copies the database
  (`VACUUM INTO` a temp file), applies every pending step and migration to the copy,
  checks that each table still holds the same rows over its old columns (under its name or as its `legacy_`
  archive), and drops the copy. The live database is only read. Optional, since SQLite also backs up before a breaking migration.
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
    restores the commits from the bundle and runs no agent (`tests/worker-crash-resume.test.ts`);
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
    leased with a succeeded step journaled by another `code_version` (that `resumes` does not accept) is requeued
    to run from the start: `adopt` answers `foreign_journal` and leaves the run and its journal as they are, and
    the runner ends it as `code_version_restart` (infra), so the controller's retry is a new run with a new journal
    that counts as an infra restart (05-restarts). It no longer fails `not_resumable`, and a lease lost before
    `adopt` holds the run fails `lease_lost` (decision changed 2026-11-21, issue #718; replaces "fails
    `not_resumable`", see History). The finished step's result is not reused. The engine's own `claim` still
    leaves such a run for a worker on its revision. Failed or running rows hold only a partial, so a paused or
    requeued run whose steps all failed keeps its journal and survives a deploy with its WIP (decision changed
    2026-11-09, worker review finding 4; see History). Each process
    stamps the revision its supervisor built it from (`SF_CODE_VERSION`, 08-self-update), or `dev` unsupervised.
  - Named timeouts per run kind (`timeouts` in the kind file): `start_to_close` one hour per step by default; the
    implement kind's `run-agent` step gets two hours (7,200,000 ms), above twice `run_timeout_ms`, since it holds
    the toolchain warm-up and the agent, each with its own `run_timeout_ms`, then the pack checks and the bundle
    save; the resolve kind's `resolve` step gets three hours (decision changed 2026-11-13, issue #671; see
    History). `heartbeat` the default `lease_ms`, `schedule_to_close` a week from
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
- **Commands and runs carry passports** (since 2026-11-08, RFC 0015 M9 wiring; details in 08-permissions.md,
  "Passports in the running factory"; Slack commands minted at relay too, decision changed 2026-11-09, issue #479,
  see History). A CLI or UI command row stores its actor's passport id; inbound mints one for a comment command row
  and for a stream record's command event (a Slack `/approve`; not a plain comment or an item request) at relay
  time, before its commit (a passport minted for a commit that loses its cursor race is never used), and puts it on
  `InboundReceived`, so `CommandReceived` or `SourceEventReceived` inherits it as its cause's `passport_id`. The
  controller's handler puts a record's passport on its command event's actor, checked for expiry at the record's
  received time (`readRecord`, `src/inbound/records.ts`). The
  RFC puts this in the normalizer; it is at the relay because the normalizer runs inside the consumer's
  transaction, and Identity writes `identity_passports` on its own connection. A run passport is minted at run start
  and checked by the ToolBroker on every call. The controller decides a command under its passport (Identity checks
  it, the origin's auth plugin decides the role) and auto mode under its service passport; every decision is
  written to `authz_audit`.
- **The merge queue** (decision changed 2026-11-16, a merged result that fails its checks is sent back to implement;
  before that 2026-11-09, the landing is an outbound delivery; see History). A red check for failing checks names
  what broke and sends the item back: the `merge-check` run's red result (`why: checks`) holds the failing command,
  its exit text, the failing tests by name (`failing_tests`, `file > name`, at most 10, parsed as the implement run's
  `checks_failed` does) and the output tail (`output_tail`, at most 2000 characters, through the egress scan first; a
  flagged tail is withheld whole as null, the names are kept). The queue removes the entry with a reason naming the
  failing tests (with none, the command and its exit text) and sends the item back to an implement run as a loop
  (`merge_check_failed`: stage RUNNING, loop_count + 1, one implement run keyed by the new loop), whose prompt lists
  the names in a fenced, untrusted section; at `max_loops` it blocks on a human (`max_loops`) and the message says
  so. The item moves first, conditionally on it still waiting for the merge, then the entry leaves, so a repeat
  changes nothing. No base rerun first: a test that also fails on the base still sends the item back. A conflict, a
  check run that could not run and a check that timed out keep the item at merge_pending, with no loop counted.
  A local change merges only through
  the `merge-queue` unit, one `MergeQueue` actor per project and base branch (state table
  `src/controller/actors/merge-queue/`, snapshots `controller_merge_queues` and `controller_merge_queue_entries`,
  migrations `20261109T0300-controller-merge-queue` and `20261109T1030-controller-merge-queue-heads`; each entry is
  a `MergeQueueEntry` actor; the queue id is a hash of project and base, so any length fits a key). Entry: only
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
  merge_pending, except after failing checks: sent back to implement, above), every entry checked with it ahead is rebuilt (queued again), and the queue moves on. A result or
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

- Replaced decisions of this topic: [history/10-event-driven.md](history/10-event-driven.md).
