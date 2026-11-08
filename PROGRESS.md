# RFC 0015 refactor: progress

## Summary

The factory is moving to RFC 0015: an event-driven factory of independent, restartable actors. M0, M1 and M2 are done.
The cores of M3 (bus), M6 (worker engine), M9 (passports) and M10 (extension points) are merged on
`refactor/rfc-0015`. M4 put intake on the bus: inbound polls and stores records, and the controller consumes them
from `controller.commands`. M5 moved the legacy controller into discovered controller units
(`src/controller/units/`; `core/controller.ts` is gone); the units still do their own I/O. M6 moved the worker into
`src/worker/` (discovered run kinds) and runs every run through the ExecutionEngine's step journal; a run whose worker
dies resumes after its last finished step (`core/worker.ts` is gone). The live database is not migrated: the owner runs
`npm run migrate` after reviewing the branch, and a rehearsal on a copy lost no row. Two M10 choices wait on the owner.
Next are M7 (outbound), M8 (merge queue), the M5 follow-up (pure load/decide units) and the M6, M9 and M10 leftovers.

The RFC and the target schema live in `~/Desktop/software-factory-rfcs/` (`0015-event-driven-factory.md`,
`0015-target-schema.sql`). This file says what exists today on the `refactor/rfc-0015` branch, what is still legacy,
and what comes next. It is updated with every milestone.

The refactor runs in the main session, not through the factory. The factory (supervisor, cron loops, background agents)
is paused until it lands.

## Overnight timeline (2026-11-08 → 09, owner asleep)

Goal: the refactor complete, reviewed, and the review's fixes applied. Each step ends green (typecheck, SQLite suite,
MySQL suite alone, rehearsal) and is committed on `refactor/rfc-0015`. Agents run in worktrees, time-boxed at 90
minutes; past that the main session takes over from their WIP commit.

| Time | Step | Who | Status |
|---|---|---|---|
| 22:07 | M4 merged (453af93) | main | done; SQLite + MySQL suites green, rehearsal passed |
| 22:26 | M3 leftovers merged (487c50b): bus + ticks plugins, `requires`, dead-letter alarms | agent | SQLite green |
| 22:50 | M5 router + units merged (2b837d5): `controller.ts` gone (22 discovered units, unit-purity ratchet of 42) | agent | SQLite green |
| 22:57, 23:04 | M6 `worker.ts` onto the engine (c086e15); M9 wiring: passports at the edge and in the ToolBroker, service passports, UI names (56b60f4) | agents | SQLite green |
| 23:20–23:25 | Pure units on ticks (bf0e449); M8 merge queue, depth 1 (39bcb41); M7 outbound, controller half (0964cd6) | agents + main | SQLite green; main fixed flush starvation and the G5 retry loop |
| 23:31, 23:40 | M11 contract migrations for `legacy_*` (e28aab9), drop order fix (cf1af90) | main | written, applied only by `migrate --contract` |
| 23:43 | Review of bus, inbound, identity, state, runtime fixed (0115682): forged passport links, consumer emits on a retried transaction, concurrent revoke, key-file race | main | 10 findings; bus ordering/leases/start/INSERT IGNORE went to the bus-fixes agent |
| 23:43 | M8 leftovers merged (42f815e): unit messages + MergeCheckTimedOut, speculative depth (`merge_queue.depth`), before_merge hooks, router and run-kind startup checks | agent + main | SQLite green (3710) |
| 23:49, 23:56 | Pure units 2 + M9 command auth merged (02c065e): one reply path, 9 more units through reader/commit (ratchet 38 → 25), commands decided under their passport. Main: passport expiry checked at the command's recorded time (bc112cf) | agent + main | SQLite green (3714) |
| 00:09–00:16 | M6 leftovers + M10 roles/hooks (645c82a); M7 worker half (5d7e597); bus review fixes: seq-ordered inserts, lease renew, explicit start, insert-or-skip (cfcbd20, 8435fb5) | agents + main | SQLite green |
| 00:25 | Controller review fixes (adec77b): auto stop after a failed settings write, comment command passports, streamed event retried on a store error, merge-check invariant | main | SQLite green (3730); each new test fails without its fix |
| 00:27 | One `addMs` in `shared/time.ts` (a2edc15) | main | SQLite green |
| 00:12–00:28 | Merge queue review findings (b2464a7, 99f4c4b): crash-safe landing with a lease, only the checked head lands, stale results and timers ignored, auto entries re-checked against auto mode | agent | merged 00:32 (fast-forward), SQLite green (3738); MySQL merge-queue tests green |
| 00:12–01:02 | M7 push (1336cd4…982effb): the implement run's push and PR open/update leave through outbound (`git.store_branch` → keyed `push`/`pr` intents, `blocked_on: outbound` / `pr_pending`); push and forge failures are outbound retries; wip branch named in the run passport (worker finding 1) | agent | merged 01:05 (fast-forward), SQLite green (3746) |
| 00:30–00:36 | Review of the worker (read-only agent): 7 findings. 1 (wip-branch push refused by the run passport) handed to m7-push; 2 (resume in a fresh folder) waits for m7-push; 3–7 (step abort signal, resume blocked by failed rows, passport end vs lease, recording error hides the cause, deadline) to an agent | agents | 3–7 fixed by worker-fixes (151453e…0112ca5): abort reaches the agent and the folder outlives it, only succeeded rows block a resume, passport end needs the minting lease token, the step error survives a journal failure, deadline comment corrected (update/improve still never hit the deadline: in Next); merged 00:48, SQLite green (3742), engine tests green on MySQL |
| 01:05–01:32 | Full MySQL suite with no agents: 20 timeouts at one worker per CPU, green at 4 workers (4079 tests, 6 min); `test:mysql` capped at 4 workers (82f2a57). MySQL schema snapshot was stale for outbound action results (6102c6b). Rehearsal passed (every row of 42 tables kept) | main | done |
| 01:33– | M7 rest: resolve/update/wip pushes, PR body refresh, session push and PR, sub-issue filing, outbound's service passport (m7-rest); outbound `local` merge delivery and base push (local-merge) | 2 agents | running, time box 90 min |
| 01:33–01:37 | Worker finding 2 (fdaf3a6): an interrupted agent step starts a new session instead of resuming in a fresh folder; the partial-session resume removed | main | SQLite green (3747); the test fails without the fix |
| next | Merge both agents; M11 cleanup: file budget back to 600, ratchets, docs, ARCHITECTURE.md | main | |
| then | Review of the whole branch, fixes applied; full SQLite + MySQL suites and rehearsal with no agents running | main | |

Not done without the owner: migrating the live database, applying the `legacy_*` drop, pushing the branch, the open
owner decisions below. Status per row is updated here as each step lands.

## Milestones

| M | Milestone | Status | Note |
|---|---|---|---|
| 0 | Foundations: shared kernel, architecture tests + ratchet, schema snapshot, migration safety kit | done | 6235fc9 |
| 1 | Table renames to `<component>_` prefixes (backup → expand → backfill → verify → swap) | done | aa4d554; rehearsed on a copy of the live MySQL DB |
| 2 | Components and discovery | done | 2279de4, 8e46469; re-planned: CLI + plugin discovery now, legacy code moves with its rewrite |
| 3 | Bus (EventBus, sql plugin, topics, outbox/inbox, retry scheduler) | core merged | merge 8823984; bus contract green on SQLite and MySQL; review fixes (seq order, leases, start position, key-only skip) on `refactor/rfc-0015-bus-fixes`; components' outboxes not wired yet |
| 4 | Inbound (adapters + normalizers; GitHub sync out of the controller) | done (strangler) | inbound polls and stores, `normalize-source` → `controller.commands` → legacy decisions; command tables merged (D7) |
| 5 | Controller units (router + pure `decide()` units; `controller.ts` gone) | units done, not pure yet | branch `refactor/rfc-0015-m5-controller`: router + `defineUnit`, 22 units, `controller.ts` gone, WorkItem table checked on every stage change, `unit-purity` test; split into load/decide: reaper, mirror, transitions; reading through the reader and writing through the kernel: outbox (the one reply path), auth, checks-gate, run-results, commands, app-requests, standing, verdicts, merge-check; the rest in its ratchet |
| 6 | Workers (step journal, ExecutionEngine, timeouts, heartbeat/reaper) | done (update steps left, with M7) | branch `refactor/rfc-0015-m6-worker`: `core/worker.ts` gone; `src/worker/` runner + `runs/<kind>/` (discovered); every run on the engine (`plugins.engine`, default `journal`); named timeouts per kind; crash tests resume mid-implement and mid-resolve on SQLite and MySQL. Leftovers (branch `refactor/rfc-0015-m6-leftovers`): the runner's waits on a TickGenerator, one takeover path (the controller's reaper; the engine's `reap` deleted), the resolve step with a bundle, `SF_CODE_VERSION` as `code_version`. Left: update steps (its effects are the forge writes M7 moves) |
| 7 | Outbound (aggregators, batches, delivery handlers; no forge writes in workers) | controller half, worker comments, implement push and PR done | `src/outbound/`: intents, §15.1 batching, targets, flush with G5 withheld notices; `outbound.batching` setting; `forge-writes` ratchet. Worker comments (gate, review, update) are thread entries outbound delivers; the broker's `github.comment` is gone; keyed actions (`intent_key`) and the PR close through `github-change`. Implement push and PR (branch `refactor/rfc-0015-m7-push`): the run's last step `git.store_branch` writes HEAD to a factory-repo ref and records keyed `push`/`pr` intents to `git:<host>:<branch>`; `github-push` (`Forge.pushBranch`, reconciling) and `github-change` (`Forge.openPr`) deliver them; the item waits `blocked_on: outbound`/`pr_pending` until the PR delivery puts `change_ref` on it and queues the review; push/PR failures are delivery retries holding the destination (no claim pause); flow test `tests/outbound/run-push.test.ts`; the run passport names the wip branch. Left: resolve, update, wip and session pushes, the PR body refresh, base push (`local` target), sub-issue filing, outbound's service passport |
| 8 | Merge queue | depth N, timeout, hook merged | `merge-queue` unit, `MergeQueue` + `MergeQueueEntry` actors and tables, `merge-check` run kind; `factory merge` and auto mode go through the queue; `merge_queue.depth` (speculative depth, solo default 1); delayed `MergeCheckTimedOut` on `controller.events` (units emit bus messages); `before_merge` hooks at the landing; flow test (`tests/merge-queue-flow.test.ts`, SQLite and MySQL): a red merged result never lands, depth 2 lands two changes on one check each, a stuck check times out, a hook veto keeps the base. Review fixes: crash-safe landing (lease take-over, finally, `land` repeatable), missing check runs queued again, results and timers conditional on the run, the checked branch head pinned, automatic entries re-authorized at the landing, `run_key` index, hashed queue id; `paused` dropped. Left: the outbound `local` merge delivery (M7 takes over `LocalMergeUnit.land`), `github-change` merge, batches with bisect, partitions; cancelling a removed entry's queued check run |
| 9 | Identity and passports | wired | merge 6be1042 (core); branch `refactor/rfc-0015-m9-wiring`: run passports checked by the ToolBroker (G2), service passports, edge passports on command rows, every auth decision in `authz_audit`, display names on the status page; commands decided under their passport through `authorize(passport_id, …)` with the origin's plugin grants, auto mode under the controller's service passport; left: SecretStore key for enterprise, outbound's service passport |
| 10 | Extension points (hooks, roles, Rule of Two, settings-monotonic) | core done, run path wired | merge 1162d29 (branch `refactor/rfc-0015-m10-extensions`): settings catalog + `settings-monotonic`, run roles + `rule-of-two`, hooks + audit table. Branch `refactor/rfc-0015-m6-leftovers`: roles drive every agent step's prompt and tools; `before_run` hooks at run start, enabled by the PR-only `hooks` setting. Left: `before_merge` (merge queue) and `before_delivery` (outbound) |
| 11 | Cleanup (contract migrations, docs, empty ratchet lists) | contract migrations written | e28aab9: `legacy_*` drops for M1 and M4, run only by `npm run migrate -- --contract` 14 days after their rename (not applied); docs, ratchets and the file budget left |

## Architecture today

What exists today. NEW is RFC 0015 structure; LEGACY is code that goes as its milestone rewrites it.

```
src/
  shared/               NEW     the kernel; imports nothing outside itself
                                - envelope (ids-only payloads), defineHandler, defineTopic (+ partitions, backoff)
                                - defineSetting, defineRole (+ ruleOfTwoRefusal, approvalRefusal), defineHook (+ Timer)
                                - ticks/: TickGenerator; time-based and manual plugins
  runtime/registry/     NEW     discovery of *.handler.ts and *.topic.ts (and *.setting.ts, *.role.ts, *.hook.ts
                                through loadDescriptors); dispatch rules (a command has one handler)
  runtime/              NEW     index.ts (public API)
                                - settings/: catalog.ts (loadSettingCatalog, generated docs/settings.md), monotonic.ts
                                  (resolveLevels: owner > org > project > pack > user, never looser)
                                - run-roles/: loadRoles, golden cases per role
                                - hooks/: runHooks (after the guards, budgeted, fail closed), SqlHookAudit
                                - migrations/20261108T2310-runtime-hook-decisions
  <component>/settings/ NEW     one <key>.setting.ts per settable and PR-only key (defineSetting), in its owner
                                component: controller, worker, inbound, runtime, state, identity, guards
  controller/           NEW     M5: the decisions (core/controller.ts is gone)
                                - router/: unit.ts (defineUnit, UnitOperations), router.ts (dispatch by event kind,
                                  tick steps in order), actor.ts (state tables)
                                - actors/work-item/: the WorkItem state table, checked on every stage change
                                - units/<unit>/<unit>.unit.ts: 22 discovered units (intake, commands, phases, closes,
                                  standing, verdicts, pr-events, run-results, checks-gate, coordination, merge-check,
                                  alarms, mirror, app-requests, local-merge, reaper, model-probe, improve, sync, auth,
                                  transitions, outbox); units/kernel.ts (shared deps, sources, settings, guard),
                                  units/support.ts (shared declarations); the units still do their own I/O
                                - handlers/legacy-controller/: bus → router bridge (name kept: inbox consumer name)
  worker/roles/         NEW     one <kind>.role.ts per agent run kind (defineRole): prompt, tools, Rule of Two facts,
                                golden
  worker/               NEW     M6: index.ts (public API), pool.ts (worker loops), runner.ts (claims a run through the
                                store, adopts it into the engine, drives its kind; its waits are schedules on its
                                TickGenerator; prompts and tools from the run's role; `before_run` hooks),
                                support.ts (shared helpers), bundle.ts (git bundles of a step's commits),
                                run-kind.ts (defineRunKind, loadRunKinds)
                                - runs/<kind>/<kind>.run.ts: triage, implement, review, update, resolve, improve;
                                  each kind's body, its own helpers and its named timeouts
  worker/engine/        NEW     ExecutionEngine (index.ts) and the journal engine (plugins/journal/, a `plugins.engine`
                                plugin, default)
                                - named steps journaled in worker_run_steps (a stored result wins)
                                - lease fencing by token, adopt (a run the store's claim leased), heartbeat ticks,
                                  named timeouts, code_version pinning (the supervisor's SF_CODE_VERSION); no
                                  takeover of its own (the controller's reaper requeues)
  worker/migrations/    NEW     20261108T1730-worker-run-journal: worker_run_steps, worker_runs.code_version/deadline_at
  cli/                  NEW     command.ts (defineCommand), index.ts (loadCommands), support.ts
                                - handlers/: one folder per command: dev, loops, status, stats, workers, resume,
                                  link-code, settings, ui, migrate, setup, doctor, llm-check, golden, issue, session,
                                  local, improve, canary
  bus/                  NEW     index.ts (EventBus, Inbox, Relay, RetryScheduler, deliver)
                                - scheduler/: bus schedules on a TickGenerator
                                - plugins/sql/: SqlEventBus (outbox publish + relay, partition cursors with leases,
                                  competing rows, retries, dead letters, delayed messages, inbox dedupe);
                                  SqlRetryScheduler (release horizon, retention, replay); ddl.ts (per-topic tables
                                  from the topic descriptor)
                                - migrations/: bus_topics, bus_scheduler
  state/                NEW     SqlDriver interface (moved from impl/store/sql/driver.ts), schema snapshots, discovery
                                - migrate/backup.ts: backup, verify a copy, restore; order-independent checksums
                                - migrate/migration.ts: defineMigration
                                - migrate/runner.ts: timestamped migrations after the frozen baseline, recorded in
                                  runtime_schema_migrations
                                - migrate/copy-tables.ts: rename by copy + verify, old tables to legacy_*
                                - migrate/rehearse.ts: D8, fingerprint, then no row lost
                                - migrations/20261108T1300-state-prefix-tables: the M1 rename of 39 tables
  identity/             NEW     index.ts (public API)
                                - passport/types.ts: Authorization, AuthProvider, GrantSource, PassportChecker
                                - passport/token.ts: HMAC chain (mint, narrow, verify offline)
                                - passport/restrictions.ts: caveats that never widen
                                - passport/service.ts: PassportService (authenticate, narrow, authorize, check,
                                  revoke, audit); its clock is the `revocations` tick
                                - passport/keys.ts (keyring over a secret provider), passport/store.ts
                                - plugins/local/: local identity, OwnerGrant
                                - migrations/20261108T2000-identity-passports: identity_passports, _revocations,
                                  authz_audit
                                - profiles/: ProfileStore (display names by user id);
                                  migrations/20261108T2345-identity-profiles
  core/                 LEGACY  policy, coordination, controller-deps.ts (the controller role's deps type),
                                worker-deps.ts (WorkerDeps, routing; goes with M7), ...
  impl/                 LEGACY  plugin implementations (store, github, slack, sandbox, runner, ...)
  interfaces/           LEGACY  FactoryStore (136 methods) and the other plugin interfaces
  ui/                   LEGACY  HTTP API and pages for web/
  compose.ts            LEGACY  hand wiring (shrinks with M4–M7)
  main.ts                       reads --config, finds the command among cli/handlers, runs it (43 lines)
  plugins.ts                    plugin registry; walks all of src/ for *.plugin.ts and *.grant.ts
schema/                 NEW     sqlite.sql, mysql.sql: generated snapshots of a fresh migration (npm run schema:snapshot)
tests/architecture/     NEW     dependency-direction, file-budget, no-clock, table-ownership, schema-snapshot,
                                registry-rules (handler-layout, dispatch-coverage, topic-ownership, envelope-shape),
                                migration-naming, migration-safety, settings-monotonic, rule-of-two, passport,
                                state-machines
                                - known-violations/*.json: the ratchet lists (they only shrink)
```

Data flow: inbound polls the sources and the forge, stores each record with an `InboundReceived` message, and its
`normalize-source` handler publishes `CommandReceived` / `SourceEventReceived` on `controller.commands`. The
controller's `legacy-controller` handler hands each to the controller role's router, whose unit decides and still
writes the store and the thread outbox itself. Workers still claim runs from the store, then run them as journaled
steps; a run's comments are thread entries outbound delivers, while pushes and PR writes are worker steps until
outbound takes them (M7).

## Data and migrations

- The store (`impl/store/sql`) speaks the prefixed names. The old tables sit as `legacy_<old>` until M11.
- `npm run migrate -- --rehearse` runs pending migrations on a copy of the database and checks every row survived.
- Live database: not migrated yet. The owner runs `npm run migrate` after reviewing the branch.
- Rehearsal on a copy (2026-11-08): backed up 41 tables / 8,937 rows, applied step 0041 and the M1 rename, and found
  no lost row.

## Ratchet (known violations)

The lists in `tests/architecture/known-violations/*.json` only shrink. Counts checked against those files on
2026-11-08.

| Test | Count | Meaning |
|---|---|---|
| table-ownership | 1 | `schema_migrations` (SQLite baseline bookkeeping; goes when M11 squashes the baseline) |
| table-ownership-sql | 0 | empty list |
| file-budget | 0 files | src files over 60,000 lines: the owner raised the 600 limit 100× for the refactor; M11 sets it back to 600 and relists the big files |
| no-clock | 36 files, 44 reads | legacy clock reads and timers (`known-violations/no-clock.json`); M6 moved `core/worker.ts`'s one entry (the Clock import of WorkerDeps) to `core/worker-deps.ts` |
| rule-of-two | 3 | roles with no golden case yet (triage, implement, resolve) |
| unit-purity | 25 | controller units that reach I/O (store, auth, forge, sources, sandbox, LLM, network probe, restarts); a unit goes once its reads go through the kernel's reader and its writes through `commit`/`commitItem` (reaper, mirror, transitions also split into load/decide) |
| dependency-direction | 295 | `component-imports-legacy` from `cli/` (commands still call compose/core; the guided setup), `controller/settings/floors.setting.ts`, and M4's strangler seams (`inbound/intake.ts`, `inbound/records.ts`, `controller/index.ts`, `runtime/roles/controller-role.ts`), and M5's units (119 entries exposed by the move: they import core helpers and legacy interface types); they go as legacy code goes |

## Decisions taken while implementing

All decisions are dated 2026-11-08.

Plan and order:

- The merge queue moved after the controller units (M8), so it is built once on the new structure.
- Table renames come first (M1), so every later step writes SQL against the final names.
- M3 bus core, M6 engine core and M9 passport core run as background agents in their own worktrees (new folders only),
  while the main session does the moves that touch every file.

M1 (table renames):

- `command_inbox` and `app_command_requests` are renamed separately (`inbound_commands`, `inbound_app_requests`). They
  merge into one `inbound_commands` in M4 when their code is rebuilt (D7).
- `cli_commands` and `item_messages` had no code left. M1 only archives them as `legacy_*`.
- Tests that rolled a migrated database back to an old schema step and re-ran it were removed. They cannot work once
  the store only knows the new names. Upgrade tests from old states still run.
- Added `npm run migrate -- --rehearse` (D8). Wired the D1 backup folder (`<stateDir>/db/backups`) into MySQL
  `npm run migrate`, which had none.

M4 (inbound on the bus):

- The main session took M4 over from its agent after 40 minutes (owner's call); the agent's WIP commit is kept.
- Strangler: the controller consumes from the bus but still decides with the legacy code. The bridge writes its inbox
  row after the old code commits (at-least-once; the old handlers may run twice).
- Topics are partitioned by stream, not record id, so a forge merge is still handled before the issue close it
  caused. Commands retry with backoff for about 16 hours before a dead letter, as the old loop held them.
- `npm run migrate` creates the discovered topics' tables (`ensureDiscoveredTopicTables`), so an enterprise DB user
  needs no DDL at run time. Details: `docs/design/10-event-driven.md`, "Intake runs in inbound, on the bus".

Bus review fixes (2026-11-09, findings 1, 5, 6, 7 of the RFC 0015 review):

- Writers to one sequence commit in seq order through a lock row (`bus_topics`, `inbound_sequence_locks`), not a
  reader high-water mark. A new consumer group starts at `latest` when the role subscribes it at start; a handler
  opts into `earliest`. Leases are renewed before each handle. `insertOrSkip` catches duplicate keys on MySQL
  instead of `INSERT IGNORE`. Details: `docs/design/10-event-driven.md`.

M2 (components and discovery):

- The registry lives in `src/runtime/registry/`, not `src/shared/`, because discovery reads the file system and
  `shared/` does no I/O.
- The tick generator became a plugin choice in the M3 leftovers (`plugins.ticks`: `time-based`, `manual`).
- M2 re-planned (RFC §11): legacy code moves into its component in the milestone that rewrites it. The
  dependency-direction ratchet takes the newly visible `component-imports-legacy` entries with that move.

M3 (bus):

- The sql bus's per-topic tables are created by an ensure step from each discovered topic descriptor
  (`ensureTopicTables`), not by a migration per topic, and recorded in `bus_topics`. A change of a topic's partitions
  or consumption is refused there and needs a bus migration. The schema snapshot runs it.
- The bus's time is a release horizon in `bus_scheduler`, moved by the retry scheduler's tick. Retries, delayed
  messages and claim leases are due against it, so consumers never read a clock.
- A delayed message on a partitioned topic is parked (retries row, attempt 0) and the cursor moves past it, so a timer
  never holds up its partition. It is delivered when due, outside partition order.
- Leftovers done: `plugins.bus` (`sql`) and `plugins.ticks` (`time-based`, `manual`) are built by compose through the
  plugin registry and handed to the controller role. Their descriptors sit in `src/impl/bus/` and `src/impl/ticks/`:
  a component file importing `plugin-api.ts` would be a new dependency-direction violation (the plugins test accepts
  a legacy descriptor whose implementation is in a component's `plugins/` folder). Competing topics filter by
  `requires` against a consumer's `capabilities` (column added by `20261109T0100-bus-competing-requires`). Dead
  letters announce themselves on `system.alerts`; the controller's `dead-letter-alarm` handler stores a
  `dead_letter` alert that Needs you shows. Details: `docs/design/10-event-driven.md`.

M6 (engine):

- `ExecutionEngine` grew `claim`, `complete`, `attach`, `heartbeat` and `reap` beside the RFC's `step`, so a Temporal
  or Restate engine can own leases too.
- The journal is keyed by (run, step) as in the target schema. `attempt` is the attempt that last ran the step.
- Engine time is the latest tick's (no clock).

M6 (worker port):

- Run kinds are `src/worker/runs/<kind>/<kind>.run.ts` (`defineRunKind`), not the RFC's `handlers/role-<kind>/`:
  they are not bus handlers yet (runs are still claimed from the store), and `src/worker/roles/` keeps the Rule of
  Two profiles on the gate list.
- Claims stay in the store's `claimRun` (its coordination, claim pauses and branch-writer lock); the engine grew
  `adopt` (hold a run another claim path leased under its token) and `release`. The journal engine also takes
  `leaseMs` (the live `lease_ms` at each renewal) and `onLost`.
- One takeover path, the controller's reaper (M6 leftovers): it requeues expired runs (backoff, `max_attempts`,
  closed items, interactive sessions, attempt records) and the next claim resumes them from the journal. The
  engine's own `reap`/`attach`/`onTakeover` are deleted; a run past its deadline is aborted by its worker's
  heartbeat or refused at its next step, and the worker fails it `schedule_to_close`.
- The runner's waits are schedules on its TickGenerator over the injected clock (`claim`, `heartbeat`,
  `pause-watch`, `diff-watch`). `Tick.due` (one period after the previous tick ended) carries the host-sleep check;
  a schedule's period may be a function read before each wait, so live `tick_ms`/`heartbeat_ms` still apply.
- Resolve is one `resolve` step (merge through gates; 3 h step timeout) carrying a bundle of its merge commit, so a
  takeover before the push pushes that exact commit. Update gets no step here: its boundaries are its push and PR
  comments, which the parallel M7 worker-half change rewrites (kept clear of those call sites to avoid conflicts).
- Roles drive prompts and tools through `Worker.roleSpec` (role file -> `prompts/<file>`, tools by name). Hooks:
  `before_run` after `passports.begin`, failure code `hook_refused` (task, not infra); `hooks` is a PR-only list
  checked against the discovered hooks at startup (a typo would silently leave the owner's check off).
- Implement's `run-agent` result carries a G5-scanned git bundle of its commits (the pause's bundle code), so a
  takeover on another host restores them. The bundle is written with `base64 -i`, not `sh -c`, so no shell runs
  outside the checks.
- `WorkerDeps`, `routeFor`, `hasTool`, `prTitle` and `TRUSTED_GIT_ENV` stay legacy in `core/worker-deps.ts`: the
  session command (`core/session.ts`) uses them, and WorkerDeps still carries the injected Clock, which
  `src/worker/` may not import.
- `ExecutionEngine` became the plugin kind `engine` (19 interfaces); `factory.config.json` names `journal`.
- Named timeouts: one hour per step, a week per run, the lease as heartbeat (`DEFAULT_TIMEOUTS`); every kind uses
  the defaults for now. `tests/worker-continue.test.ts` moved its far-future rate-limit reset inside the week.

M9 (identity and passports):

- `narrow` returns the new passport's id and its token (`Issued`), not only the id as in the RFC's sketch, because a
  run needs the token for the ToolBroker.
- Authorize by id re-signs the stored chain, so an edited `identity_passports` row is refused (`tampered`).
- Person passports last 1h by default, 7 days at most.
- The solo identity is git `user.email`, then the OS user, then `anonymous`, as in the legacy CLI. Git `user.name` is a
  display name and is not used.
- Setup (owner decision): `factory setup` is a guided flow (store, plugins, mode, then the secret steps; `--yes`,
  `--me`), in `src/cli/handlers/setup/`.
- Display names live once in `identity_profiles` (migration 20261108T2345). It is a table of its own rather than a
  column on `identity_local_users`, because a person with no role and an enterprise user have no local row (design
  08-permissions).
- `narrow` is called only from `worker/` and `identity/` (`tests/architecture/passport.test.ts`).
- Wiring: the run passport token stays in the worker process keyed by run id (`RunPassports`), and the broker
  wrapper (`PassportToolBroker`) reads it there, so neither `ToolCallContext` nor the agent runner spec carries it.
- Wiring: run passports have no `paths` caveat (the broker sees no file list; the scope gate checks
  `allowed_paths`) and no tier caveat. Their tools are the worker's own forge tools per run kind plus `tool_grants`.
- Wiring: comment commands get their passport at inbound's relay, not in the normalizer (the normalizer runs in
  the consumer's transaction; Identity writes on its own connection). `CommandReceived` inherits it.
- Follow-up: Identity decides a command with a passport (chain, expiry, revocation, caveats, principal) and asks the
  origin's auth plugin for the role half (`RoleCheck`), so the grants stay where they were; with none, the plugin
  decides and the audit row says `none`. Auto mode's approvals and merges go through `service:controller`.
- Wiring: the solo key is `<state>/passport.key` (0600, on `deny_paths`); `SF_PASSPORT_KEY` from the SecretStore
  is not wired.
- Wiring: service passports last 24 h and renew at half-life; revoking one ends its runs' passports, and the next
  run gets a fresh one.

M10 (extension points):

- Settings live in their owner component (`src/<owner>/settings/<key>.setting.ts`). The legacy resolver keeps its key
  lists (it types values by them), and `tests/settings-catalog.test.ts` holds both equal.
- Descriptions and "applies at" moved out of `src/core/settings.ts` into the setting files.
- Runtime overrides map onto the levels as they are: a global override is the owner's live value, a project override
  the project level.
- `mode` is `free`, not tighten-only (see "Waiting on the owner").
- Rule of Two facts are classified strictly. Output the factory later posts through outbound is not the run's own
  `external_effect`. `implement` and `resolve` hold all three and are declared not autonomous. `ruleOfTwoRefusal`
  refuses them without a person's approval, but auto mode does not call it yet (gate change).
- Role profiles live in one folder, `src/worker/roles/`, so one gate-list prefix covers them. The RFC's
  `handlers/role-<kind>/` stays for the role's run code in M6.
- `runtime/run-roles/` avoids the RFC's `runtime/roles/` (process roles).
- Hooks fail closed on timeout or error.

M5 (controller units):

- The move was mechanical (a generator over the class: method bodies unchanged, `this.x` → the owning unit's
  operation) and landed in one commit, not one unit per commit: a partial move would have needed the old class and
  the router to call each other. The contract and router are a commit of their own before it.
- Units call each other through `ctx.unit(name)`, typed by declaration merging into `UnitOperations`, not by import.
- `ControllerRole` keeps its public `tick*`, `applyRun`, `mergeLocal`, `handleEvent`, `consume*` methods as thin
  router calls, so the ~70 test files did not change; tests that reached into private methods now use
  `role.unit(name)` or `role.kernel`.
- The `legacy-controller` handler keeps its name: it is the inbox consumer name of every handled message.
- The standing-rule gate list (`PROTECTED_PATHS`, and so `GATE_PATHS`) names `src/controller/` in place of the
  removed `src/core/controller.ts`: the same protection, now for the units, the router and the state tables.
- The coordination default `hotspot_paths` still names `src/core/controller.ts` (now matches nothing). Choosing its
  replacement (a unit file, the units folder, or none) changes how items are held, so it waits on the owner.
M5 follow-up (pure units, partial):

- The contract: `PureStep`/`PureEvent` (`load(…, reader, tick)`, `decide(…, loaded, tick)` → `{ writes }`); the
  router commits through `Kernel.commit`. The writes of one decision are applied in order, each keyed or
  conditional, not yet in one transaction: the store has no way to run several of its writes in a caller's
  transaction (only `applyTransition` internally).
- The units' loop is one `decide` schedule on a TickGenerator over the injected `Clock` (`TickSource.create` takes an
  optional time source). `tick_ms` is read again before each wait (`Period`), as it was each pass before.
- Pure: `reaper`, `mirror`, `transitions`. `transitions`' follow-ups (`outbox.showStatus`, `local-merge.stopAuto`)
  are still other units' operations, which the unit-purity regex does not see.
- Follow-up (second pass): every reply is a `threadEntry` write (`outbox.post` commits it; the earlier delivery's
  URL is read first), `auth` and the forge's PR check reads are on the reader, and `stopAuto`, verdicts, budget
  answers, coordination approvals, app request marks and standing rules are kernel writes. That takes `outbox`,
  `auth`, `checks-gate`, `run-results`, `commands`, `app-requests`, `standing`, `verdicts` and `merge-check` off the
  ratchet. They are not split into load/decide: `run-results` and `commands` still interleave reads, other units'
  operations and writes in one method, so their messages cannot yet commit with the inbox row in one transaction
  (not built for that reason). `merge-check` still hands the store and sandbox to `MergeChecker`, which the regex misses.
- The `legacy-controller` bridge keeps "inbox row after the effect" for every message; nothing it carries is
  exactly-once yet.
- Still reading `clock.now()` in units: `run-results` (2), `coordination` (5), `model-probe` (2), `commands` (1),
  `improve` (2, one is its `fileReport` deps).

Worker review fixes (2026-11-09, findings 3–7):

- A step's timeout or the run deadline also aborts the run kind's signal, in the runner's `step` wrapper (one place
  for every kind), and a failed step settles only after its work has, so the folder outlives the agent. This relies
  on the work honouring its signal (agent runners kill their process on abort).
- `deadline_at` stays enforced by the worker (heartbeat, next step), as design 10-event-driven decided; only the
  migration's note claimed the reaper. Update and improve, which journal no step, still never fail on it.
- A resume on other code is blocked only by a succeeded step row; ending a run passport needs the claim's lease
  token; a journal write failing in a step's error path is logged and the step's error stays the failure.

## Waiting on the owner

- Migrate the live database: `npm run migrate` after reviewing the branch.
- M5 `hotspot_paths` default: it still names the removed `src/core/controller.ts`; pick its replacement or drop it.
- M10 `mode`: it is `free`, not tighten-only, because #444 lets a project choose auto under a global manual, with
  `approve_merge`. The RFC's "a lower level may never raise autonomy" would refuse that.
- M10 gate list: `tests/architecture/` is not on it yet. A spec allowing `tests/` would then always need the owner (a
  folder holding a gate path touches it).
- M10 auto mode and the Rule of Two: auto mode approves specs without a person but does not call
  `ruleOfTwoRefusal` yet (implement and resolve hold all three facts). Wiring it is a gate change.

## Next

0. M6 leftovers: steps for update, with the worker half of M7 (its push and PR comments are its only effects).
1. M5 follow-up: pure units, leaves first. Done: the contract, the TickGenerator loop (`tick_ms` live), `reaper`,
   `mirror`, `transitions` split; the one reply path; `outbox`, `auth`, `checks-gate`, `run-results`, `commands`,
   `app-requests`, `standing`, `verdicts`, `merge-check` read through the reader and write through the kernel. Next:
   split `commands` and `run-results` into load/decide (their methods still interleave reads, other units' operations
   and writes); `merge-check`'s `MergeChecker` off the store; the rest of the ratchet (`intake`, `closes`, `phases`,
   `coordination`, `pr-events`, `sync`, `improve`, `alarms`, `model-probe`); then a store call that runs a decision's
   writes and the inbox row in one transaction, and the `legacy-controller` bridge's "inbox row after the effect" goes.
2. M3 leftovers (the bus plugin, `requires` and dead-letter alarms are done):
   - outbox and inbox migrations for the components not on the bus yet (worker, outbound);
   - the worker declares its `capabilities` when `runs.requests` lands (M6);
   - `factory dead-letters replay` (the scheduler's `replay` exists) and `blocked_on: dead_letter` in the router (M5).
3. M10 wiring follows its call sites: hooks at delivery (`before_delivery`, M7); the run start (`before_run`),
   the merge queue's landing (`before_merge`), the `hooks` setting and roles driving prompts and tools are done.
4. M7 worker half, rest (design in 10-event-driven.md, "An implement run's push and PR"; the implement run's push
   and PR are done): the resolve, update and wip pushes and the PR body refresh in `runner.ts` take the same
   `store-branch` + keyed intents path; the session push and PR (`core/session.ts`); the base push (`local` target);
   sub-issue filing as a keyed `file_sub_issue` action. The `forge-writes` ratchet lists what is left.
5. M9 follow-up:
   - M7: outbound uses its service passport;
   - the enterprise key: `SF_PASSPORT_KEY` declared and read through the SecretStore, the key file only for solo;
   - sessions (`factory session`) push through an unguarded broker: give them a passport;
   - a `paths` caveat once a git proxy at the sandbox edge sees the files;
   - the web app shows `actor.name` and `merged_by_name` (the server pages already do);
   - an OIDC or GitHub provider implementing `AuthProvider.displayName`;
   - components get their SQL driver from the runtime (today `storeSql` takes it from the legacy store).
6. M4 follow-up (with M5/M11, as `FactoryStore` shrinks): `listInboxAfter` and `listCliCommandsAfter` are read only by
   tests now; the store's command-row mapping duplicates `commandOf` in `src/inbound/records.ts`.
7. M8 leftovers: the outbound `local` merge delivery (the merge queue emits `DeliveryRequested{kind: merge}` and
   outbound's delivery handler runs `LocalMergeUnit.land`), the `github-change` merge delivery, batches with bisect
   and partitions; a `paused` state with the command that needs it; cancelling a removed entry's queued check run.

## After the refactor: acceptance runs (owner request, 2026-11-08)

Once M0–M11 are done, the factory is run for real, end to end, on the new architecture:

1. GitHub: an issue filed on GitHub goes intake → triage → implement → review → merge, with comments and labels synced.
2. Slack: a work item started from a Slack thread goes the same way, with replies in the thread.
3. Local: a `factory task create` item goes the same way with no external plugin selected.
4. Concurrency: several items from all three sources at once, with several workers. No double runs, no lost
   commands, dependent items wait for each other, conflicting changes are coordinated.
5. Feedback and self-improvement: review feedback and failed runs reach the improve loop. The factory files its own
   improvements, and they land through the same gates.

Each run records what broke. Fixes go through the factory itself where possible.
