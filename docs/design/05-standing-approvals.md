# 5. Coordination: standing approvals

- **The page adds, pauses, edits and removes the rule, and every change is recorded** (decision changed 2026-11-22,
  wi_5c1c03d0; before: each write was the rule row and one log line, with no audit row, see History).
  - **Writes.** `POST /api/v1/standing` takes `{ rule, enabled, proposal? }` (add: on, creating the row if none; pause:
    off), `{ rule, action: "remove" }`, which deletes the rule row (`deleteStandingRule`), and
    `{ rule, action: "edit", threshold }`, which sets the one global `standing_approvals.threshold` through the Settings
    write (`writeSettings`: the same refusals as `factory settings set`, a 422). The threshold is not a field of the
    rule, and the only rule is still `spec-t1`. Each write is behind the same request guards and owner check
    (`approve_spec`); a refusal is a 403 whose text names the missing permission, with nothing written. Nothing is
    written when nothing would change (`changed: false`): a pause of a rule already off or with no row, a remove with
    no row, an edit to the threshold in force.
  - **Change record.** `controller_standing_rule_changes` (migration `20261122T1300-state-standing-rule-changes`), one
    row per change: `gate`, `tier`, `action` (`add`, `pause`, `edit`, `remove`), `before_value` and `after_value`
    (JSON `{"enabled":…}` or `{"threshold":…}`; null before an add with no row and after a remove), `actor` (a user
    ID, never a display name) and `at`. `putStandingRule` writes its record in the transaction that writes the row, so
    `/standing accept|decline`, the turn-off after `/revise` or `/reject` and the page each leave one record per write
    (an accept records `add`, a decline `pause`); `deleteStandingRule` writes its record with the delete; an edit's is
    written by `recordStandingRuleChange` once the setting is stored (its `runtime_settings_changes` audit row stays).
    There is no second copy of the rule and no file. Store methods: `StandingChangeStore` in `src/core/standing.ts`,
    implemented in `src/impl/store/sql/standing-rules.ts`.
  - **Preview.** `GET /api/v1/standing` adds `waiting` (`[{ id, title }]`, through the Withholder): the items waiting
    now that the rule covers (`waitingForRule` and `ruleWouldApprove`): READY, on a human, `spec_pending` (the
    spec-gate dial held them), tier 1, the latest spec not a split and not held (no file changed, dropped request
    values or owner answers), and allowed paths touching no protected category (`protectedCategory`, with the
    project's floors). It reads the newest 100 such items from the store, with no remote call. Turning the rule on
    does not approve them at once: the rule acts when a spec's triage outcome is applied, as before.
  - **Not built:** a history view of the records on the page; a timed pause (a pause lasts until the rule is turned
    on again); any rule but `spec-t1`. Page: `09-dashboard-rules.md`.
- **The page shows and changes rules** (decision changed 2026-11-21, wi_1cf90455; before: "last used" was not
  recorded and showed "not recorded", see History). On the Rules page each rule that is on is a row of "In effect"
  and each one that is off a row under its Details (since 2026-11-22): its switch, its sentence, when it last fired and
  the items it approved in the last 7 days, each linked by its title; gate, tier, the effective threshold, who set it
  and created behind the row's Details. Pending proposals are rows of "Waiting for you". Firings are read, never written, from the
  stored `standing_approved` state changes whose actor is `standing:<rule>`. Each pending proposal (its
  rule not on and not written since the proposal was stored, read from the stored rows alone) with Accept and
  Decline. Read: `GET /api/v1/standing`; write: `POST /api/v1/standing` (the decision above), behind
  the resume route's guards and its owner check (`approve_spec`, the `/approve` check), so the page accepts what
  `/standing accept|decline` accepts and refuses any rule but `spec-t1`. A rule already in the asked state is not
  written. Each write is the rule row (`set_by` = the factory user ID), its change record (the decision above) and
  one log line. Routes and guards: `09-dashboard-app.md`. One code path
  for one worker or many: the user is the owner, the linked local account or `cli_user`, and that ID goes in
  `set_by`.
- **A rule acts at the spec gate** (decision changed 2026-11-07, issue #299, phase 2 of 3 of #293; before: phase 1
  recorded and checked, and nothing acted on a rule, see History).
  - **One rule: `spec-t1`.** A rule ID is `<gate>-t<tier>`; the only rule is tier 1 specs at the spec gate
    (`STANDING_TIER`), so a rule never approves a spec above tier 1. `/standing accept|decline` of any other ID is refused.
  - **Proposal.** After an `/approve` (comment, CLI or app request) is applied, the controller reads the spec decisions of
    the newest 200 items (or 4 × the threshold, if more), runs `checkRuns`, and posts one proposal comment on this item
    when the tier 1 run equals the threshold, this item's latest decision is an unchanged tier 1 approval, the rule is
    not on, and it was not declined since the run started (`dueProposal`). The proposal is stored with
    `recordStandingProposal` as it is; the comment's marker is keyed on the rule, the item and the approval's time, so a
    second check of the same approval posts nothing. Later approvals in the same run are past the threshold and post
    nothing; a run that resets and reaches it again posts again, on that run's item.
  - **Accept and decline.** `/standing accept spec-t1` writes the rule on (`putStandingRule`, `set_by` = the user's ID);
    `/standing decline spec-t1` writes it off, which also keeps a proposal quiet until the run resets (a raised threshold
    met in the same run stays quiet too). Who may: the same check `/approve` uses (`approve_spec`). A rule already in
    the asked state is not written and gets no reply. See `04-gate-commands.md`.
  - **Approval by a rule.** A tier 1 spec that waits at the gate (`dials.spec_gate_min_tier` unchanged: the rule never
    acts on a spec that dial lets through, and never on a split spec) is approved in the triage outcome's transition
    when the rule is on: reason `standing_approved`, actor `standing:spec-t1`, detail `standing_rule`, `gate`, `tier`,
    `kind` and `owner_id` (the rule's `set_by`), implement run queued. The spec comment names the rule, who turned it
    on, and how to turn it off. `standing_approved` is not a human decision, so the run check does not read it.
  - **Protected paths.** A rule never approves a spec whose allowed paths touch, by the floor touch rule (under the
    prefix, or covering it): gates (`src/controller/` since RFC 0015 M5, before it `src/core/controller.ts`; `policy.ts`, `diff-gate.ts`, `pre-push.ts`, `checks.ts`,
    `merge-check.ts`, `standing.ts`; since 2026-11-09 also `src/compose.ts` and `src/outbound/outbound.ts`, which wire
    G1, the run passport check and G5, and the architecture ratchets `tests/architecture/`, design 03-risk), prompts
    (`prompts/`), permissions (`src/core/authorize.ts`, `src/impl/auth/`, `src/impl/grant/`, `.claude/`, `src/identity/`
    since 2026-11-09, `src/worker/roles/` and `src/shared/role.ts` since 2026-11-09, RFC 0015 M10), tools (`src/core/tools/`, `src/impl/broker/`, the
    default broker `src/impl/github/github-tool-broker.ts` and `broker.plugin.ts` since 2026-11-09), guard settings
    (`factory.config.json`, `src/core/config.ts`, `src/core/settings.ts`, `src/config-keys.ts`, `src/plugins.ts`,
    `src/impl/egress/`, `src/impl/secrets/`) or the item's configured floors (`PROTECTED_PATHS`, `protectedCategory`).
    Such a spec waits for `/approve` as before.
  - **Turn-off.** A `/revise` or `/reject` applied, by a user who may approve specs, on an item a rule approved writes
    that rule off with the user's ID and posts one reply saying so; a rule already off is left alone.
  - **Threshold.** `standing_approvals.threshold` is a `factory settings set` key (global, live, audited in
    `runtime_settings_changes`), default 10, read at each approval with no restart; anything but a positive whole number is
    refused on set and ignored when the stored overrides load. It is not a config file key. See `08-settings.md`.
  - **One worker or many.** The same code path: the local user is the owner and the threshold is 10; the owner check
    applies on every worker, with user IDs in `set_by` and `owner_id`. No new schema, migration or store method.
- **Spec decisions are recorded for standing approvals** (2026-11-07, issue #298, phase 1 of 3 of #293).
  - **Decision detail.** Every `spec_approved`, `spec_rejected` and `spec_revision_requested` state change, and the
    `split_approved` change of a split's `/approve`, carries in its `detail`: `gate` (`spec`, the only gate so far),
    `tier` (the item's tier when the human decided), `kind` (`phase` for an item with a parent, `split` for a spec that
    proposes phases, else `single`), `outcome` (`approved`, `rejected`, `revised`), `spec_changed` and `owner_id` (the
    deciding user's factory user ID, never a display name). `spec_changed` is true for a revise, true for an approval
    that widened the allowed paths (`+paths`), false otherwise. The controller adds it in one place (`withSpecDecision`
    in the command path), so the gate outcomes are the same as before.
  - **Run check** (`checkRuns` in `src/core/standing.ts`, pure). Per (gate, tier), events in time order: an approval with
    the spec unchanged adds one to the run; a revise, a reject, a retry or an approval that changed the spec sets it to
    0. It reports `run_length` and `reached` (`run_length >= threshold`); the threshold is an input
    (`standing_approvals.threshold`, above).
  - **Retries and backfill** (`gateEvents`). A retry is read from the `retry_requested` rows already written, at the
    item's tier; no new row. A row written before the detail existed is backfilled from its reason, its field changes
    and the item's tier at that row (the latest `tier` change before it); a row whose tier is not known is skipped.
  - **Rules and proposals.** `controller_standing_rules`: one row per (gate, tier) with `enabled`, `set_by` (a user ID),
    `created_at`, `updated_at`. `controller_standing_proposals`: one row per (gate, tier, run_length) with `threshold`; storing the
    same proposal again writes nothing and returns the stored one, so two replicas finding the same run leave one row.
    Store methods on `FactoryStore` (`putStandingRule`, `listStandingRules`, `recordStandingProposal`,
    `listStandingProposals`), implemented once in the shared SQL store.
  - **Schema.** SQLite migration 32. The spec named
    24; 24 to 31 had already shipped, so this takes the next free number.
  - **Solo and enterprise.** The same: rules are keyed by (gate, tier) only, and every replica reads the same rows.

- Replaced decisions of this topic: [history/05-standing-approvals.md](history/05-standing-approvals.md).
