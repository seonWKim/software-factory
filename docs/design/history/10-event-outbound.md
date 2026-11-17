## History

- **Outbound wait time and Slack refusals** (decision changed 2026-11-10, issue #483). Before: a failed batch always
  retried on its backoff and ignored the error's `wait_until`; a Slack error had only a method and a code, so a 429
  was `rate_limited` with its `Retry-After` unread, and `channel_not_found` and `not_in_channel` had no status and
  were retried forever.
- **Rule of Two at run start** (decision changed 2026-11-09, owner decision). Before: `ruleOfTwoRefusal` existed but
  no run start called it, so an implement or resolve run started once its item was approved, by a person or by auto
  mode, and in auto mode they ran with all three facts and no person.
- **Sub-issue filing through outbound** (decision changed 2026-11-09, M7). Before: the phases unit called
  `fileSubIssue` inline, every phase in one `/approve` pass (the last `forge-writes` ratchet entry); a failure
  refused the approval and put the spec back at the gate, and a claim left by a stopped process could be taken over
  by `/approve` after 10 minutes.
- **Building the bus** (decision changed 2026-11-08, M3 leftovers). Before: the controller role constructed
  `SqlEventBus`, `SqlRetryScheduler` and `TimeBasedTickGenerator` itself, with no config choice.
- **Roles and hooks in the run path** (decision changed 2026-11-08, M6 leftovers). Before: each run kind passed its
  own system prompt and tool list, the role files only declared them; no hook point was called and nothing enabled
  a hook.
- **Outbound writes** (decision changed 2026-11-09, RFC 0015 M7). Before: the controller's outbox step and its
  transitions called the sources and the forge directly (comments with retries, labels and 👀 best effort, closes
  inline), outside any batch, and outbox delivery never waited on the forge budget.
- **An implement run's push and PR** (decision changed 2026-11-09, RFC 0015 M7 worker half). Before: the implement
  run pushed its branch (`github.push_branch`) and opened or updated its PR (`github.open_pr`) through the broker in
  its own steps, returned the PR number in its result, and a push or PR failure failed the run, kept a wip branch and,
  for `forge_auth` or a rate limit, paused claims. The decision before the build keyed the PR intent `pr:<branch>`.
- **Update, resolve, wip and session pushes** (decision changed 2026-11-09, RFC 0015 M7 rest). Before: the update
  and resolve runs, the wip branch and `factory session finish` pushed through the broker's `github.push_branch`,
  the PR body refresh and the session's PR went through `github.open_pr`, a forge failure failed the run, and the
  review after an update or resolve was queued as soon as the result was applied.
- **A run's comments** (decision changed 2026-11-09, RFC 0015 M7 worker half). Before: the worker posted its gate,
  review and update comments itself through the broker's `github.comment`, inside the run, and an update run failed
  when its comment failed.
- **Hook points** (changed 2026-11-11, issue #494). Before: three points (`before_merge`, `before_run`,
  `before_delivery`), all for `*.hook.ts`, and `hooks` named only `*.hook.ts` files; nothing ran a pack's checks.
- **An enabled `before_delivery` hook** (changed 2026-11-09, runtime review L1). Before: startup accepted it (the
  name was discovered) though nothing ran it, so every delivery went out unchecked with no error.
