# 10. Event-driven factory: outbound, run roles and hooks

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
  - A failed write waits for its error's wait time, and Slack's permanent refusals are given up (decision changed
    2026-11-10, issue #483; see History). A failed comment or action retries its batch after the later of the
    backoff and the error's `wait_until` (a forge rate limit's reset, a Slack 429's `Retry-After`), so a retry never
    goes before the limit ends. The Slack client's errors carry an HTTP status: a 429 is status 429 with
    `wait_until` from `Retry-After` when present (none: the backoff, never given up); `channel_not_found` is 404
    and `not_in_channel` is 403, which Slack sends as `ok: false` on an HTTP 200, so they are given up like a forge
    4xx on `REFUSED_ATTEMPTS`. Other Slack codes, token errors (`invalid_auth`, `token_revoked`) among them, carry
    no status and retry. The Retry-After parser is one shared helper (`src/shared/retry-after.ts`) for the Slack and
    chat clients. Solo and enterprise: the same; no setting.
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
  `before_run` is called and the `hooks` setting enables them; changed 2026-11-11, issue #494: four pack check
  points, see History). A hook is
  `src/<component>/hooks/<name>/<name>.hook.ts` (`defineHook`, `src/shared/hook.ts`) at one point (`before_merge`,
  `before_run`, `before_delivery`) with a budget of at most 10 s. `HOOK_POINTS` also holds the four pack check
  points (`before_agent`, `on_tool_call`, `before_finish`, `after_agent`), where only a pack layer's
  `checks/<name>.json` runs (04-pre-push-gates.md): they are in `UNCALLED_HOOK_POINTS`, so a `*.hook.ts` enabled at
  one fails startup. `hooks` names both kinds; a name a pack layer has is a pack check, any other must be a
  discovered `*.hook.ts`. A pack check's refusal is a `runtime_hook_decisions` row like a hook's. `runHooks` (`src/runtime/hooks/`, on the gate list)
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

- Replaced decisions of this topic: [history/10-event-outbound.md](history/10-event-outbound.md).
