## History

- **Legacy contract checks and copies before it drops** (decision changed 2026-11-15). Before: two contract
  migrations, `20261109T0900-state-drop-legacy-tables` (M1's `legacy_*`) and
  `20261109T0901-inbound-drop-legacy-commands` (M4's), dropped their tables without checking that each row was in
  its current table, missed the change-ref rebuild's two legacy tables, and `--contract` had no dry run; the table
  docs and `HIDDEN_COLUMNS` listed every `legacy_*` copy.
- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the current decisions named MySQL beside SQLite in schema changes (MySQL steps up to `0041` in `migrations/mysql/`, applied by `npm run migrate`), backups, renames, contract migrations, rehearsal (a snapshot into `<database>_rehearsal`), the worker-crash and bus contract tests, the sql bus (enterprise: MySQL), the seq cursors (MySQL assigns AUTO_INCREMENT at insert, not at commit, so a reader's `seq > cursor` could pass a lower seq whose transaction commits later), `insertOrSkip` (a plain INSERT whose duplicate-key error was caught on MySQL), the topic tables an enterprise MySQL user needed no DDL rights for, and the merge-queue id length that fits MySQL's key.
- **Implement run-agent step budget** (decision changed 2026-11-13, issue #671). Before: the implement kind's
  `run-agent` step had the shared `start_to_close` of one hour per step (above the agent's own `run_timeout_ms`,
  which fires first); warm-up plus agent could pass one hour, so the step failed `start_to_close`.

- **Outbound wait time and Slack refusals** (decision changed 2026-11-10, issue #483). Before: a failed batch always
  retried on its backoff and ignored the error's `wait_until`; a Slack error had only a method and a code, so a 429
  was `rate_limited` with its `Retry-After` unread, and `channel_not_found` and `not_in_channel` had no status and
  were retried forever.
- **Slack commands carry passports** (decision changed 2026-11-09, issue #479). Before: inbound minted passports
  only for command rows; a Slack command's stream record was relayed with none, so the controller decided it with
  the auth plugin alone.
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
- **A merged result that fails its checks** (decision changed 2026-11-16). Before: the `merge-check` run's red
  result held only the command, its exit text and the SHAs; the entry left with a reason naming only the command
  ("fix it on the branch and run the merge again"), and the item stayed at REVIEW / merge_pending with no run queued
  until a person sent `/revise` or merged again.
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
- **Hook points** (changed 2026-11-11, issue #494). Before: three points (`before_merge`, `before_run`,
  `before_delivery`), all for `*.hook.ts`, and `hooks` named only `*.hook.ts` files; nothing ran a pack's checks.
- **An enabled `before_delivery` hook** (changed 2026-11-09, runtime review L1). Before: startup accepted it (the
  name was discovered) though nothing ran it, so every delivery went out unchecked with no error.
- **Topic tables at start** (changed 2026-11-09, runtime review M3). Before: every start ran each topic's
  `CREATE TABLE IF NOT EXISTS` even when `bus_topics` listed it, so a MySQL user without CREATE rights failed at the
  first `wire()` and the controller restarted in a loop.
- **Unconsumed handlers and failed builds** (changed 2026-11-09, runtime review L2, L3). Before: a handler in a
  component no role consumes (worker, identity) passed the dispatch check and its messages piled up with no
  error; and a failed `build()` or discovery stayed cached as a rejected promise, so every later call failed the
  same way for the life of the object.
- Decision changed 2026-11-12 (issue #646): the generated table list is `schema/sqlite.sql` only; the unread `schema/mysql.sql` snapshot is deleted.
