# 5. Coordination: standing approvals

- **The page shows and changes rules** (decision changed 2026-11-08, issue #300, phase 3 of 3 of #293; before: rules
  and proposals were shown and changed only through `/standing`, see History). The Settings page's "Standing
  approvals" section lists each rule (gate, tier, the effective threshold, on or off, who set it, created, and last
  used, which is not recorded yet and shows "not recorded") with an on or off switch, and each pending proposal (its
  rule not on and not written since the proposal was stored, read from the stored rows alone) with Accept and
  Decline. Read: `GET /api/v1/standing`; write: `POST /api/v1/standing` with `{ rule, enabled, proposal? }`, behind
  the resume route's guards and its owner check (`approve_spec`, the `/approve` check), so the page accepts what
  `/standing accept|decline` accepts and refuses any rule but `spec-t1`. A rule already in the asked state is not
  written. Each write is the rule row (`set_by` = the factory user ID) and one log line, with no audit row; a stored
  per-person audit record (enterprise) is a follow-up. Routes and guards: `09-dashboard-app.md`. Solo and
  enterprise: one code path; solo, the user is the linked local account or `cli_user`; a team member's own ID goes in
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
    `merge-check.ts`, `standing.ts`), prompts (`prompts/`), permissions (`src/core/authorize.ts`, `src/impl/auth/`,
    `src/impl/grant/`, `.claude/`), tools (`src/core/tools/`, `src/impl/broker/`), guard settings
    (`factory.config.json`, `src/core/config.ts`, `src/core/settings.ts`, `src/config-keys.ts`, `src/plugins.ts`,
    `src/impl/egress/`, `src/impl/secrets/`) or the item's configured floors (`PROTECTED_PATHS`, `protectedCategory`).
    Such a spec waits for `/approve` as before.
  - **Turn-off.** A `/revise` or `/reject` applied, by a user who may approve specs, on an item a rule approved writes
    that rule off with the user's ID and posts one reply saying so; a rule already off is left alone.
  - **Threshold.** `standing_approvals.threshold` is a `factory settings set` key (global, live, audited in
    `runtime_settings_changes`), default 10, read at each approval with no restart; anything but a positive whole number is
    refused on set and ignored when the stored overrides load. It is not a config file key. See `08-settings.md`.
  - **Solo and enterprise.** The same code path: solo, the local user is the owner and the threshold is 10; a team gets
    the same permission check, with user IDs in `set_by` and `owner_id`. No new schema, migration or store method.
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
    `listStandingProposals`), implemented once in the shared SQL store for SQLite and MySQL.
  - **Schema.** SQLite migration 32 and MySQL step `0032-standing-approvals.sql`, same tables and columns. The spec named
    24; 24 to 31 had already shipped, so this takes the next free number.
  - **Solo and enterprise.** The same: rules are keyed by (gate, tier) only, and every replica reads the same rows.

## History

- **A rule acts at the spec gate** (decision changed 2026-11-07, issue #299). Before: spec decisions were recorded and
  checked and nothing acted on them; no command accepted or declined a rule, no proposal was posted, and
  `standing_approvals.threshold` was named as a config key to be wired later.
- **The page shows and changes rules** (decision changed 2026-11-08, issue #300). Before: phase 3 was named as a
  separate item; rules and proposals were shown and changed only through `/standing`, and the status page had no route
  for them.
