## History

- **A run journaled by another code_version failed `not_resumable`** (decision changed 2026-11-21, issue #718;
  changes the 2026-11-09 "Resume across a deploy" rule under "Claims still go through the store's `claimRun`").
  Before: a run the store leased whose journal held a succeeded step from another `code_version` was refused by
  `adopt` and failed `not_resumable` (infra); its retry was a new run with a new journal. Six runs failed this way
  with finished agent work (the improver's pattern; the resume attempt itself was not in the evidence).
- **Legacy contract checks and copies before it drops** (decision changed 2026-11-15). Before: two contract
  migrations, `20261109T0900-state-drop-legacy-tables` (M1's `legacy_*`) and
  `20261109T0901-inbound-drop-legacy-commands` (M4's), dropped their tables without checking that each row was in
  its current table, missed the change-ref rebuild's two legacy tables, and `--contract` had no dry run; the table
  docs and `HIDDEN_COLUMNS` listed every `legacy_*` copy.
- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the current decisions named MySQL beside SQLite in schema changes (MySQL steps up to `0041` in `migrations/mysql/`, applied by `npm run migrate`), backups, renames, contract migrations, rehearsal (a snapshot into `<database>_rehearsal`), the worker-crash and bus contract tests, the sql bus (enterprise: MySQL), the seq cursors (MySQL assigns AUTO_INCREMENT at insert, not at commit, so a reader's `seq > cursor` could pass a lower seq whose transaction commits later), `insertOrSkip` (a plain INSERT whose duplicate-key error was caught on MySQL), the topic tables an enterprise MySQL user needed no DDL rights for, and the merge-queue id length that fits MySQL's key.
- **Implement run-agent step budget** (decision changed 2026-11-13, issue #671). Before: the implement kind's
  `run-agent` step had the shared `start_to_close` of one hour per step (above the agent's own `run_timeout_ms`,
  which fires first); warm-up plus agent could pass one hour, so the step failed `start_to_close`.
- **Slack commands carry passports** (decision changed 2026-11-09, issue #479). Before: inbound minted passports
  only for command rows; a Slack command's stream record was relayed with none, so the controller decided it with
  the auth plugin alone.
- **Outbound review fixes** (decisions changed 2026-11-09). Before: a join updated the open batch with no state
  check and no claim-token move, so an intent joined between a flush's read and its claim ended in a sent batch
  unsent (finding 1); git destinations named `os.hostname()` (from the replica id, `local` with none), and a
  controller with a replica id, which compose always set, flushed only its own hostname's, so the carried base
  pushes on `git:local:` were never sent and a changed hostname orphaned pending git writes (findings 2, 5); a base
  push shared `git:<host>:<base>` with the merges, so a failing push held every later landing (finding 3); a PR or
  push delivered while the run's result was decided was missed and the item stayed `pr_pending` (finding 4); a
  retried delivery retried forever, holding its destination with only a warning (finding 6); a base that moved
  during a local merge came back `refused` and removed the entry (finding 7).
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
- **Table names and schema steps** (decision changed 2026-11-08, RFC 0015 M1). Before: unprefixed tables shared
  by every part of the code, schema changes appended to SQLite's numbered list and to `migrations/mysql/`
  (still in force for steps up to `0041`, see 05-coordination.md "MySQL schema steps").
- **CLI commands** (decision changed 2026-11-08, RFC 0015 M2). Before: `src/main.ts` held one `switch` case per
  command and one hand-written help text.
- **Plugin discovery root** (decision changed 2026-11-08, RFC 0015 M2). Before: only `src/impl/` was walked.
- **Passports on commands and runs** (decision changed 2026-11-08, RFC 0015 M9 wiring). Before: every message
  had `passport_id` null, and no run held a passport.
- **Takeover and the worker's waits** (decision changed 2026-11-08, M6 leftovers). Before: the engine had its own
  `reaper` tick (take a run over in place, fail runs past their deadline), not attached in the worker, beside the
  controller's reaper that requeued; and the runner's waits slept on the injected Clock in `while` loops.
- **Contract migrations** (decision changed 2026-11-09, RFC 0015 M11). Before: the runner applied every pending
  migration, a contract one too, on open (SQLite) and on `npm run migrate` (MySQL); none was written yet.
- **Outbound's passport** (decision changed 2026-11-09, RFC 0015 M7 rest / M9). Before: outbound delivered under no
  passport and `DeliveryCompleted` carried `passport_id` null.
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
- Decision changed 2026-11-12 (issue #646): the generated table list is `schema/sqlite.sql` only; the unread `schema/mysql.sql` snapshot is deleted.
