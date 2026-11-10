// State changes by reason (design 11-signal-ledger): the owner's gate decisions (a person's, or `system:auto` or a
// standing rule's in their place), revision and retry requests, and reverts and fix-forwards. One signal per state
// change, keyed by its ID; its kind is the reason. Not run-related, so no role.

import { STANDING_APPROVED, defineSignal } from "./signal.js";

/** The reasons this source writes, each its own kind. A fixed list. */
const REASONS = [
  // Gate decisions.
  "spec_approved", "spec_rejected", "floor_tier_approved", "rule_of_two_approved", STANDING_APPROVED,
  // Revision and retry requests.
  "spec_revision_requested", "retry_requested", "pr_revise_requested", "pr_changes_requested",
  // Reverts and fix-forwards.
  "reverted", "fixed_forward",
] as const;

export default defineSignal({
  name: "state_changes",
  kinds: REASONS,
  async read(r, since) {
    const changes = await r.listStateChangesSince({ reasons: REASONS, since });
    return changes.map((c) => ({ source_ref: c.id, kind: c.reason, work_item_id: c.work_item_id, role: null, at: c.at }));
  },
});
