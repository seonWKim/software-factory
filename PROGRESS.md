# RFC 0015 refactor: progress

## Summary

The factory is moving to RFC 0015: an event-driven factory of independent, restartable actors. M0, M1 and M2 are done.
The cores of M3 (bus), M6 (worker engine), M9 (passports) and M10 (extension points) are merged on
`refactor/rfc-0015`, but none of them is wired into the running factory yet. Data still flows the legacy way through
`core/controller.ts` and `core/worker.ts`. The live database is not migrated: the owner runs `npm run migrate` after
reviewing the branch, and a rehearsal on a copy lost no row. Two M10 choices wait on the owner. Next is M4 (inbound on
the bus) plus the M3, M9 and M10 leftovers.

The RFC and the target schema live in `~/Desktop/software-factory-rfcs/` (`0015-event-driven-factory.md`,
`0015-target-schema.sql`). This file says what exists today on the `refactor/rfc-0015` branch, what is still legacy,
and what comes next. It is updated with every milestone.

The refactor runs in the main session, not through the factory. The factory (supervisor, cron loops, background agents)
is paused until it lands.

## Milestones

| M | Milestone | Status | Note |
|---|---|---|---|
| 0 | Foundations: shared kernel, architecture tests + ratchet, schema snapshot, migration safety kit | done | 6235fc9 |
| 1 | Table renames to `<component>_` prefixes (backup → expand → backfill → verify → swap) | done | aa4d554; rehearsed on a copy of the live MySQL DB |
| 2 | Components and discovery | done | 2279de4, 8e46469; re-planned: CLI + plugin discovery now, legacy code moves with its rewrite |
| 3 | Bus (EventBus, sql plugin, topics, outbox/inbox, retry scheduler) | core merged | merge 8823984; bus contract green on SQLite and MySQL; components' outboxes not wired yet |
| 4 | Inbound (adapters + normalizers; GitHub sync out of the controller) | not started | |
| 5 | Controller units (router + pure `decide()` units; `controller.ts` gone) | groundwork | 8dc1414: actor state tables + state-machines test |
| 6 | Workers (step journal, ExecutionEngine, timeouts, heartbeat/reaper) | engine core merged | merge 073f94f: `ExecutionEngine`, `journal` engine, `worker_run_steps`, contract test; `worker.ts` not ported yet |
| 7 | Outbound (aggregators, batches, delivery handlers; no forge writes in workers) | not started | |
| 8 | Merge queue | not started | |
| 9 | Identity and passports | core merged | merge 6be1042: passport service, tables, `tests/passport.test.ts`; not wired yet (ToolBroker check, edge adapters, service passports) |
| 10 | Extension points (hooks, roles, Rule of Two, settings-monotonic) | core done | merge 1162d29 (branch `refactor/rfc-0015-m10-extensions`): settings catalog + `settings-monotonic`, run roles + `rule-of-two`, hooks + audit table; not wired into the run, merge or delivery path yet |
| 11 | Cleanup (contract migrations, docs, empty ratchet lists) | not started | |

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
  controller/           NEW     M5 groundwork (8dc1414): router/actor.ts, actors/work-item/work-item.actor.ts
  worker/roles/         NEW     one <kind>.role.ts per agent run kind (defineRole): prompt, tools, Rule of Two facts,
                                golden
  worker/engine/        NEW     ExecutionEngine (index.ts) and the journal engine (plugins/journal/); not wired into
                                the legacy worker yet
                                - named steps journaled in worker_run_steps (a stored result wins)
                                - lease fencing by token, heartbeat and reaper ticks, named timeouts,
                                  code_version pinning
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
  core/                 LEGACY  controller.ts (4,959 lines), worker.ts (3,098), policy, coordination, ...
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

Data flow is still the legacy one. The controller tick polls sources, decides, and writes the store and the thread
outbox. Workers claim runs from the store and push/open PRs themselves.

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
| no-clock | 36 files, 44 reads | legacy clock reads and timers (`known-violations/no-clock.json`) |
| rule-of-two | 3 | roles with no golden case yet (triage, implement, resolve) |
| dependency-direction | 74 | `component-imports-legacy` from `cli/` (commands still call compose/core; the guided setup) and `controller/settings/floors.setting.ts`; they go as legacy code goes |

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

M2 (components and discovery):

- The registry lives in `src/runtime/registry/`, not `src/shared/`, because discovery reads the file system and
  `shared/` does no I/O.
- The time-based tick generator is a plain class for now. The re-planned M2 kept the plugin registry in place (it walks
  all of `src/`), so it becomes a `*.plugin.ts` choice when the runtime wires the bus schedules (M3 leftovers).
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

M6 (engine):

- `ExecutionEngine` grew `claim`, `complete`, `attach`, `heartbeat` and `reap` beside the RFC's `step`, so a Temporal
  or Restate engine can own leases too.
- The journal is keyed by (run, step) as in the target schema. `attempt` is the attempt that last ran the step.
- Engine time is the latest tick's (no clock).

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

## Waiting on the owner

- Migrate the live database: `npm run migrate` after reviewing the branch.
- M10 `mode`: it is `free`, not tighten-only, because #444 lets a project choose auto under a global manual, with
  `approve_merge`. The RFC's "a lower level may never raise autonomy" would refuse that.
- M10 gate list: `tests/architecture/` is not on it yet. A spec allowing `tests/` would then always need the owner (a
  folder holding a gate path touches it).
- M10 auto mode and the Rule of Two: auto mode approves specs without a person but does not call
  `ruleOfTwoRefusal` yet (implement and resolve hold all three facts). Wiring it is a gate change.

## Next

1. M4: inbound on the bus.
2. M3 leftovers:
   - each component's migration creates its outbox and inbox (`ensureComponentTables`);
   - the runtime builds the sql bus as a plugin, ensures discovered topics at start and in `npm run migrate`, and runs
     the bus schedules;
   - `requires` on competing topics (worker filtering);
   - dead-letter alerts on `system.alerts`.
3. M10 wiring follows its call sites:
   - hooks at the merge queue (M8), run start (M6) and delivery (M7);
   - roles drive the worker's prompts and tools (M6);
   - a stored setting to enable hooks.
4. M9 follow-up:
   - the UI does not show display names yet (the CLI's `users list` does);
   - an OIDC or GitHub provider implementing `AuthProvider.displayName`;
   - components get their SQL driver from the runtime (today `storeSql` takes it from the legacy store).

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
