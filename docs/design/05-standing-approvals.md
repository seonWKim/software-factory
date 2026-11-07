# 5. Coordination: standing approvals

- **Spec decisions are recorded for standing approvals; nothing acts on them yet** (new decision, 2026-11-07, issue #298,
  phase 1 of 3 of #293). Phase 1 records and checks; it changes no gate, approval or tier. Phases 2 and 3 (acting on a
  rule, showing proposals) are separate items.
  - **Decision detail.** Every `spec_approved`, `spec_rejected` and `spec_revision_requested` state change, and the
    `split_approved` change of a split's `/approve`, carries in its `detail`: `gate` (`spec`, the only gate so far),
    `tier` (the item's tier when the human decided), `kind` (`phase` for an item with a parent, `split` for a spec that
    proposes phases, else `single`), `outcome` (`approved`, `rejected`, `revised`), `spec_changed` and `owner_id` (the
    deciding user's factory user ID, never a display name). `spec_changed` is true for a revise, true for an approval
    that widened the allowed paths (`+paths`), false otherwise. The controller adds it in one place (`withSpecDecision`
    in the command path), so the gate outcomes are the same as before.
  - **Run check** (`checkRuns` in `src/core/standing.ts`, pure). Per (gate, tier), events in time order: an approval with
    the spec unchanged adds one to the run; a revise, a reject, a retry or an approval that changed the spec sets it to
    0. It reports `run_length` and `reached` (`run_length >= threshold`); the threshold is an input. The intended
    threshold is 10 (`standing_approvals.threshold`, settable live), wired in a later phase.
  - **Retries and backfill** (`gateEvents`). A retry is read from the `retry_requested` rows already written, at the
    item's tier; no new row. A row written before the detail existed is backfilled from its reason, its field changes
    and the item's tier at that row (the latest `tier` change before it); a row whose tier is not known is skipped.
  - **Rules and proposals.** `standing_rules`: one row per (gate, tier) with `enabled`, `set_by` (a user ID),
    `created_at`, `updated_at`. `standing_proposals`: one row per (gate, tier, run_length) with `threshold`; storing the
    same proposal again writes nothing and returns the stored one, so two replicas finding the same run leave one row.
    Store methods on `FactoryStore` (`putStandingRule`, `listStandingRules`, `recordStandingProposal`,
    `listStandingProposals`), implemented once in the shared SQL store for SQLite and MySQL.
  - **Schema.** SQLite migration 32 and MySQL step `0032-standing-approvals.sql`, same tables and columns. The spec named
    24; 24 to 31 had already shipped, so this takes the next free number.
  - **Solo and enterprise.** The same: rules are keyed by (gate, tier) only, and every replica reads the same rows.

## History

- (none: new topic, 2026-11-07.)
