import { type ItemPhase, type PhaseInput, phaseOf } from "./phase.js";

/**
 * Where a work item stands, as one word a reader of the source can act on. Sources show it (e.g. one
 * status label on the issue and on its PR, see SourceAdapter.setStatus). Exactly one applies at a time.
 */
export type WorkStatus =
  | "triaging"
  | "needs_approval"
  | "implementing"
  | "in_review"
  | "ready_to_merge"
  | "needs_human"
  | "done"
  | "rejected";

export const WORK_STATUSES: readonly WorkStatus[] = [
  "triaging",
  "needs_approval",
  "implementing",
  "in_review",
  "ready_to_merge",
  "needs_human",
  "done",
  "rejected",
];

/** Each phase's status. A wait on another item (a dependency, a split's phases) or on outbound shows its stage. */
const STATUS: Record<ItemPhase, WorkStatus> = {
  done: "done",
  closed: "rejected",
  spec_pending: "needs_approval",
  max_revisions: "needs_approval",
  specced: "needs_approval",
  merge_pending: "ready_to_merge",
  triaging: "triaging",
  implementing: "implementing",
  dependency_hold: "implementing",
  phase_hold: "implementing",
  phases_open: "implementing",
  delivering: "implementing",
  reviewing: "in_review",
  delivering_review: "in_review",
  budget_checkpoint: "needs_human",
  floor_tier: "needs_human",
  rule_of_two: "needs_human",
  agent_needs_human: "needs_human",
  repeated_failure: "needs_human",
  recurring_failure: "needs_human",
  dependency_closed: "needs_human",
  dependency_cycle: "needs_human",
  too_large: "needs_human",
  failed_implement: "needs_human",
  failed_review: "needs_human",
  failed_run: "needs_human",
  max_loops: "needs_human",
  merge_conflict: "needs_human",
  session_released: "needs_human",
  upstream_wait: "needs_human",
  ci_wait: "needs_human",
  budget_wait: "needs_human",
  person_wait: "needs_human",
};

/** The item's status, from its phase (core/phase.ts). */
export function statusOf(it: PhaseInput): WorkStatus {
  return STATUS[phaseOf(it)];
}
