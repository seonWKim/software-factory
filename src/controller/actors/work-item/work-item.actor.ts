// The WorkItem actor's stages (design 02-work-item). The moves are the ones the legacy controller makes,
// found by tracing every stage change in the test suite (2026-11-08) and checked against the code:
// - NEW → READY/RUNNING/REVIEW/CLOSED: triage outcome, implement start, an adopted change, a close at intake.
// - READY/RUNNING/REVIEW → NEW: a spec revision sends the item back to triage.
// - READY → REVIEW (max_loops) and REVIEW/RUNNING → READY (max_revisions): both wait on a person. RUNNING → READY is
//   an implement run's spec_conflict at the revision limit (added 2026-11-11: without it that outcome never landed).
// - CLOSED → RUNNING/REVIEW: only the red-main revert of an automatic merge (design 03-risk, 2026-11-23) reopens the
//   item it reverted, at implement or, at max_loops, waiting on a person. Any other reopened source makes a new item.

import { defineActor } from "../../router/actor.js";

export type WorkItemStage = "NEW" | "READY" | "RUNNING" | "REVIEW" | "CLOSED";

export default defineActor<WorkItemStage>({
  name: "WorkItem",
  states: ["NEW", "READY", "RUNNING", "REVIEW", "CLOSED"],
  initial: ["NEW", "REVIEW"],
  terminal: [],
  transitions: [
    ["NEW", "READY"],
    ["NEW", "RUNNING"],
    ["NEW", "REVIEW"],
    ["NEW", "CLOSED"],
    ["READY", "RUNNING"],
    ["READY", "REVIEW"],
    ["READY", "NEW"],
    ["READY", "CLOSED"],
    ["RUNNING", "READY"],
    ["RUNNING", "REVIEW"],
    ["RUNNING", "NEW"],
    ["RUNNING", "CLOSED"],
    ["REVIEW", "RUNNING"],
    ["REVIEW", "READY"],
    ["REVIEW", "NEW"],
    ["REVIEW", "CLOSED"],
    ["CLOSED", "RUNNING"],
    ["CLOSED", "REVIEW"],
  ],
});
