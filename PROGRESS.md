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
| 2 | Components and discovery (re-planned: CLI + plugin discovery now; legacy code moves with its rewrite) | done (2279de4, 8e46469) |
| 3 | Bus (EventBus, sql plugin, topics, outbox/inbox, retry scheduler) | core merged (bus contract green on SQLite and MySQL); components' outboxes not wired yet |
| 4 | Inbound (adapters + normalizers; GitHub sync out of the controller) | — |
| 5 | Controller units (router + pure `decide()` units; `controller.ts` gone) | groundwork: actor state tables + state-machines test (8dc1414) |
| 6 | Workers (step journal, ExecutionEngine, timeouts, heartbeat/reaper) | engine core merged: `ExecutionEngine`, `journal` engine, `worker_run_steps`, contract test; `worker.ts` not ported yet |
| 7 | Outbound (aggregators, batches, delivery handlers; no forge writes in workers) | — |
| 8 | Merge queue | — |
| 9 | Identity and passports | core merged: passport service, tables, `tests/passport.test.ts`; not wired yet (ToolBroker check, edge adapters, service passports) |
| 10 | Extension points (hooks, roles, Rule of Two, settings-monotonic) | core done (branch refactor/rfc-0015-m10-extensions): settings catalog + `settings-monotonic`, run roles + `rule-of-two`, hooks + audit table; not wired into the run, merge or delivery path yet |
| 11 | Cleanup (contract migrations, docs, empty ratchet lists) | — |

## Architecture today

```
src/
  shared/              NEW  envelope (ids-only payloads), defineHandler, defineTopic (+ partitions, backoff),
                            defineSetting, defineRole (+ ruleOfTwoRefusal, approvalRefusal), defineHook (+ Timer),
                            ticks/ (TickGenerator; time-based and manual plugins). Imports nothing outside itself.
  runtime/registry/    NEW  discovery of *.handler.ts and *.topic.ts (and *.setting.ts, *.role.ts, *.hook.ts through
                            loadDescriptors); dispatch rules (a command has one handler)
  runtime/             NEW  index.ts (public API). settings/: catalog.ts (loadSettingCatalog, generated docs/settings.md),
                            monotonic.ts (resolveLevels: owner > org > project > pack > user, never looser).
                            run-roles/ (loadRoles, golden cases per role). hooks/: runHooks (after the guards, budgeted,
                            fail closed), SqlHookAudit. migrations/20261108T2310-runtime-hook-decisions
  <component>/settings/ NEW  one <key>.setting.ts per settable and PR-only key (defineSetting), in its owner component:
                            controller, worker, inbound, runtime, state, identity, guards
  worker/roles/        NEW  one <kind>.role.ts per agent run kind (defineRole): prompt, tools, Rule of Two facts, golden
  cli/                 NEW  command.ts (defineCommand), index.ts (loadCommands), support.ts, and one folder per command
                            under handlers/ (dev, loops, status, stats, workers, resume, link-code, settings, ui,
                            migrate, setup, doctor, llm-check, golden, issue, session, local, improve, canary)
  bus/                 NEW  index.ts (EventBus, Inbox, Relay, RetryScheduler, deliver), scheduler/ (bus schedules on a
                            TickGenerator), plugins/sql/ (SqlEventBus: outbox publish + relay, partition cursors with
                            leases, competing rows, retries, dead letters, delayed messages, inbox dedupe;
                            SqlRetryScheduler: release horizon, retention, replay; ddl.ts: per-topic tables from
                            the topic descriptor), migrations/ (bus_topics, bus_scheduler)
  state/               NEW  SqlDriver interface (moved from impl/store/sql/driver.ts), schema snapshots, discovery,
                            migrate/: backup.ts (backup, verify a copy, restore; order-independent checksums),
                            migration.ts (defineMigration), runner.ts (timestamped migrations after the frozen
                            baseline, recorded in runtime_schema_migrations), copy-tables.ts (rename by copy +
                            verify, old tables to legacy_*), rehearse.ts (D8: fingerprint, then no row lost)
                            migrations/20261108T1300-state-prefix-tables: the M1 rename of 39 tables
  identity/            NEW  index.ts (public API). passport/: types.ts (Authorization, AuthProvider, GrantSource,
                            PassportChecker), token.ts (HMAC chain: mint, narrow, verify offline), restrictions.ts
                            (caveats that never widen), service.ts (PassportService: authenticate, narrow, authorize,
                            check, revoke, audit; its clock is the `revocations` tick), keys.ts (keyring over a
                            secret provider), store.ts. plugins/local/ (local identity, OwnerGrant).
                            migrations/20261108T2000-identity-passports: identity_passports, _revocations, authz_audit
                            profiles/ (ProfileStore: display names by user id), migrations/20261108T2345-identity-profiles
  worker/engine/       NEW  ExecutionEngine (index.ts) and the journal engine (plugins/journal/): named steps journaled
                            in worker_run_steps (a stored result wins), lease fencing by token, heartbeat and reaper
                            ticks, named timeouts, code_version pinning. Not wired into the legacy worker yet
  worker/migrations/   NEW  20261108T1730-worker-run-journal: worker_run_steps, worker_runs.code_version/deadline_at
  core/                LEGACY  controller.ts (4,959 lines), worker.ts (3,098), policy, coordination, ...
  impl/                LEGACY  plugin implementations (store, github, slack, sandbox, runner, ...)
  interfaces/          LEGACY  FactoryStore (136 methods) and the other plugin interfaces
  ui/                  LEGACY  HTTP API and pages for web/
  compose.ts           LEGACY  hand wiring (shrinks with M4–M7)
  main.ts              reads --config, finds the command among cli/handlers, runs it (45 lines)
  plugins.ts           plugin registry; walks all of src/ for *.plugin.ts and *.grant.ts
schema/                NEW  sqlite.sql, mysql.sql: generated snapshots of a fresh migration (npm run schema:snapshot)
tests/architecture/    NEW  dependency-direction, file-budget, no-clock, table-ownership, schema-snapshot,
                            registry-rules (handler-layout, dispatch-coverage, topic-ownership, envelope-shape),
                            migration-naming, settings-monotonic, rule-of-two; known-violations/*.json are the ratchet lists (they only shrink)
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
| rule-of-two | 3 | roles with no golden case yet (triage, implement, resolve) |
| dependency-direction | 74 | `component-imports-legacy` from cli/ (commands still call compose/core; the guided setup) and `controller/settings/floors.setting.ts`; they go as legacy code goes |

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
- 2026-11-08: M2 re-planned (RFC §11): legacy code moves into its component in the milestone that rewrites it;
  the dependency-direction ratchet takes the newly visible `component-imports-legacy` entries with that move.
- 2026-11-08: M3 bus core, M6 engine core and M9 passport core run as background agents in their own worktrees
  (new folders only), while the main session does the moves that touch every file.
- 2026-11-08 (M6 engine): `ExecutionEngine` grew `claim`, `complete`, `attach`, `heartbeat` and `reap` beside the
  RFC's `step`, so a Temporal or Restate engine can own leases too. The journal is keyed by (run, step) as in the
  target schema; `attempt` is the attempt that last ran the step. Engine time is the latest tick's (no clock).
- 2026-11-08: added `npm run migrate -- --rehearse` (D8) and wired the D1 backup folder
  (`<stateDir>/db/backups`) into MySQL `npm run migrate`, which had none.

- 2026-11-08 (M9): `narrow` returns the new passport's id and its token (`Issued`), not only the id as in the
  RFC's sketch, because a run needs the token for the ToolBroker. Authorize by id re-signs the stored chain, so an
  edited `identity_passports` row is refused (`tampered`). Person passports last 1h by default, 7 days at most.
- 2026-11-08 (M9): the solo identity is git `user.email`, then the OS user, then `anonymous`, as in the legacy
  CLI. Git `user.name` is a display name and is not used.
- 2026-11-08 (M3): the sql bus's per-topic tables are created by an ensure step from each discovered topic
  descriptor (`ensureTopicTables`), not by a migration per topic, and recorded in `bus_topics`; a change of a
  topic's partitions or consumption is refused there and needs a bus migration. The schema snapshot runs it.
- 2026-11-08 (M3): the bus's time is a release horizon in `bus_scheduler`, moved by the retry scheduler's tick.
  Retries, delayed messages and claim leases are due against it, so consumers never read a clock.
- 2026-11-08 (M3): a delayed message on a partitioned topic is parked (retries row, attempt 0) and the cursor
  moves past it, so a timer never holds up its partition; it is delivered when due, outside partition order.
- 2026-11-08 (M9 setup, owner decision): `factory setup` is a guided flow (store, plugins, mode, then the secret
  steps; `--yes`, `--me`), in `src/cli/handlers/setup/`. Display names live once in `identity_profiles` (migration
  20261108T2345), a table of its own rather than a column on `identity_local_users`, because a person with no role
  and an enterprise user have no local row (design 08-permissions). `narrow` is called only from worker/ and
  identity/ (`tests/architecture/passport.test.ts`).

- 2026-11-08 (M10): settings live in their owner component (`src/<owner>/settings/<key>.setting.ts`); the legacy
  resolver keeps its key lists (it types values by them) and `tests/settings-catalog.test.ts` holds both equal.
  Descriptions and "applies at" moved out of `src/core/settings.ts` into the setting files. Runtime overrides map onto
  the levels as they are: a global override is the owner's live value, a project override the project level.
- 2026-11-08 (M10): `mode` is `free`, not tighten-only: #444 lets a project choose auto under a global manual, with
  `approve_merge`; the RFC's "a lower level may never raise autonomy" would refuse that. Left for the owner.
- 2026-11-08 (M10): Rule of Two facts are classified strictly; output the factory later posts through outbound is not
  the run's own `external_effect`. `implement` and `resolve` hold all three and are declared not autonomous;
  `ruleOfTwoRefusal` refuses them without a person's approval, but auto mode does not call it yet (gate change).
- 2026-11-08 (M10): role profiles live in one folder, `src/worker/roles/`, so one gate-list prefix covers them (the
  RFC's `handlers/role-<kind>/` stays for the role's run code in M6). `runtime/run-roles/` avoids the RFC's
  `runtime/roles/` (process roles). Hooks fail closed on timeout or error.
- 2026-11-08 (M10): `tests/architecture/` is not on the gate list yet: a spec allowing `tests/` would then always need
  the owner (a folder holding a gate path touches it). Left for the owner.

## Live database

Not migrated yet. The owner runs `npm run migrate` after reviewing the branch; the rehearsal on a copy
(2026-11-08) backed up 41 tables / 8,937 rows, applied step 0041 and the M1 rename, and found no lost row.

## Next

M4 inbound on the bus. M3 leftovers: each component's migration creates its outbox and inbox
(`ensureComponentTables`); the runtime builds the sql bus as a plugin, ensures discovered topics at start and in
`npm run migrate`, and runs the bus schedules; `requires` on competing topics (worker filtering) and dead-letter
alerts on `system.alerts`.
M10 wiring follows its call sites: hooks at the merge queue (M8), run start (M6) and delivery (M7); roles
drive the worker's prompts and tools (M6); a stored setting to enable hooks.
M9 follow-up: the UI does not show display names yet (the CLI's `users list` does); an
OIDC or GitHub provider implementing `AuthProvider.displayName`; components get their SQL driver from the runtime
(today `storeSql` takes it from the legacy store).
