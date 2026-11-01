import type { WorkItem } from "./types.js";

/**
 * Where a work item stands, as one word a reader of the source can act on. Sources show it (GitHub: one
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

/**
 * Pure mapping from the fields that carry state. Anything blocked that is not one of the two expected
 * human gates (spec approval, merge) needs a human: failed runs, max_loops, merge conflicts, an unknown
 * reason, and any blocker other than `human`.
 */
export function statusOf(
  it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "close_reason">,
): WorkStatus {
  if (it.stage === "CLOSED") return it.close_reason === "completed" ? "done" : "rejected";
  if (it.blocked_on !== "none") {
    if (it.blocked_on === "human" && it.stage === "READY" && it.blocked_reason === "spec_pending") return "needs_approval";
    if (it.blocked_on === "human" && it.stage === "REVIEW" && it.blocked_reason === "merge_pending") return "ready_to_merge";
    return "needs_human";
  }
  switch (it.stage) {
    case "NEW":
      return "triaging";
    case "READY":
      return "needs_approval";
    case "RUNNING":
      return "implementing";
    case "REVIEW":
      return "in_review";
  }
}
