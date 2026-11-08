// The WorkItem actor's stages (design 02-work-item). The moves are the ones the legacy controller makes,
// found by tracing every stage change in the test suite (2026-11-08) and checked against the code:
// - NEW → READY/RUNNING/REVIEW/CLOSED: triage outcome, implement start, an adopted change, a close at intake.
// - READY/RUNNING/REVIEW → NEW: a spec revision sends the item back to triage.
// - READY → REVIEW (max_loops) and REVIEW → READY (max_revisions): both wait on a person.
// CLOSED is final: a reopened source makes a new item. Not seen: RUNNING → READY.

import { defineActor } from "../../router/actor.js";

export type WorkItemStage = "NEW" | "READY" | "RUNNING" | "REVIEW" | "CLOSED";

export default defineActor<WorkItemStage>({
  name: "WorkItem",
  states: ["NEW", "READY", "RUNNING", "REVIEW", "CLOSED"],
  initial: ["NEW", "REVIEW"],
  terminal: ["CLOSED"],
  transitions: [
    ["NEW", "READY"],
    ["NEW", "RUNNING"],
    ["NEW", "REVIEW"],
    ["NEW", "CLOSED"],
    ["READY", "RUNNING"],
    ["READY", "REVIEW"],
    ["READY", "NEW"],
    ["READY", "CLOSED"],
    ["RUNNING", "REVIEW"],
    ["RUNNING", "NEW"],
    ["RUNNING", "CLOSED"],
    ["REVIEW", "RUNNING"],
    ["REVIEW", "READY"],
    ["REVIEW", "NEW"],
    ["REVIEW", "CLOSED"],
  ],
});
