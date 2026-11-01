import { describe, expect, it } from "vitest";
import { WORK_STATUSES, type WorkStatus, statusOf } from "../src/core/status-label.js";
import type { BlockedOn, CloseReason, Stage } from "../src/core/types.js";

const item = (stage: Stage, blocked_on: BlockedOn = "none", blocked_reason: string | null = null, close_reason: CloseReason | null = null) =>
  ({ stage, blocked_on, blocked_reason, close_reason });

describe("statusOf", () => {
  const cases: [string, ReturnType<typeof item>, WorkStatus][] = [
    ["NEW, not blocked", item("NEW"), "triaging"],
    ["NEW, triage failed", item("NEW", "human", "run_failed:triage:agent_error"), "needs_human"],
    ["NEW, triage invalid output", item("NEW", "human", "run_failed:triage:invalid_output"), "needs_human"],
    ["READY, spec pending", item("READY", "human", "spec_pending"), "needs_approval"],
    ["RUNNING, not blocked", item("RUNNING"), "implementing"],
    ["RUNNING, implement failed", item("RUNNING", "human", "run_failed:implement:timeout"), "needs_human"],
    ["REVIEW, not blocked", item("REVIEW"), "in_review"],
    ["REVIEW, merge pending", item("REVIEW", "human", "merge_pending"), "ready_to_merge"],
    ["REVIEW, max loops", item("REVIEW", "human", "max_loops"), "needs_human"],
    ["REVIEW, review failed", item("REVIEW", "human", "run_failed:review:cancelled"), "needs_human"],
    ["REVIEW, review invalid output", item("REVIEW", "human", "run_failed:review:invalid_output"), "needs_human"],
    ["REVIEW, merge conflict", item("REVIEW", "human", "merge_conflict_pending"), "needs_human"],
    ["REVIEW, update failed", item("REVIEW", "human", "run_failed:update:invalid_output"), "needs_human"],
    ["CLOSED completed", item("CLOSED", "none", null, "completed"), "done"],
    ["CLOSED rejected", item("CLOSED", "none", null, "rejected"), "rejected"],
    ["CLOSED wont_do", item("CLOSED", "none", null, "wont_do"), "rejected"],
    ["CLOSED duplicate", item("CLOSED", "none", null, "duplicate"), "rejected"],
    ["CLOSED failed", item("CLOSED", "none", null, "failed"), "rejected"],
    ["unknown reason, blocked on human", item("RUNNING", "human", "something_new"), "needs_human"],
    ["unknown reason with no reason at all", item("NEW", "human", null), "needs_human"],
    ["blocked on upstream", item("RUNNING", "upstream", "x"), "needs_human"],
    ["blocked on ci", item("REVIEW", "ci", null), "needs_human"],
    ["blocked on budget", item("NEW", "budget", null), "needs_human"],
  ];
  for (const [name, input, want] of cases) {
    it(`${name} → ${want}`, () => expect(statusOf(input)).toBe(want));
  }

  it("lists exactly eight statuses, each reachable", () => {
    expect(new Set(WORK_STATUSES).size).toBe(8);
    expect(new Set(cases.map((c) => c[2]))).toEqual(new Set(WORK_STATUSES));
  });
});
