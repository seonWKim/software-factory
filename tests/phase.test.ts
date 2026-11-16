import { describe, expect, it } from "vitest";
import { type ItemPhase, PHASE_RULES, phaseOf, phaseRule } from "../src/core/phase.js";
import type { BlockedOn, CloseReason, Stage } from "../src/core/types.js";

type Row = [Stage, BlockedOn, string | null, CloseReason | null, ItemPhase];

// One row per (stage, blocked_reason) pair phaseOf tells apart: each row hits its own rule, and every rule has a row.
const TABLE: Row[] = [
  ["CLOSED", "none", null, "completed", "done"],
  ["CLOSED", "upstream", "source_close_pending", "rejected", "closed"],
  ["RUNNING", "budget", "budget_checkpoint", null, "budget_checkpoint"],
  ["RUNNING", "human", "floor_tier", null, "floor_tier"],
  ["RUNNING", "human", "rule_of_two", null, "rule_of_two"],
  ["REVIEW", "human", "agent_needs_human", null, "agent_needs_human"],
  ["RUNNING", "human", "repeated_failure", null, "repeated_failure"],
  ["RUNNING", "human", "recurring_failure", null, "recurring_failure"],
  ["RUNNING", "human", "dependency_closed:#1", null, "dependency_closed"],
  ["RUNNING", "human", "dependency_cycle: #1 → #2 → #1", null, "dependency_cycle"],
  ["RUNNING", "human", "run_failed:implement:diff_too_large", null, "too_large"],
  ["RUNNING", "human", "run_failed:implement:timeout", null, "failed_implement"],
  ["REVIEW", "human", "run_failed:review:cancelled", null, "failed_review"],
  ["NEW", "human", "run_failed:triage:agent_error", null, "failed_run"],
  ["REVIEW", "human", "run_failed:update:invalid_output", null, "failed_run"],
  ["NEW", "human", "max_attempts", null, "failed_run"],
  ["RUNNING", "human", "max_attempts", null, "failed_implement"],
  ["REVIEW", "human", "max_attempts", null, "failed_review"],
  ["NEW", "human", "max_restart", null, "failed_run"],
  ["RUNNING", "human", "max_restart", null, "failed_implement"],
  ["REVIEW", "human", "max_restart", null, "failed_review"],
  ["READY", "human", "spec_pending", null, "spec_pending"],
  ["READY", "human", "max_revisions", null, "max_revisions"],
  ["REVIEW", "human", "merge_pending", null, "merge_pending"],
  ["REVIEW", "human", "max_loops", null, "max_loops"],
  ["REVIEW", "human", "merge_conflict_pending", null, "merge_conflict"],
  ["RUNNING", "dependency", "waiting for #12 to merge", null, "dependency_hold"],
  ["NEW", "upstream", "phase_hold", null, "phase_hold"],
  ["READY", "upstream", "phases_open", null, "phases_open"],
  ["READY", "upstream", "split_filing", null, "upstream_wait"],
  ["REVIEW", "ci", "checks_pending", null, "ci_wait"],
  ["NEW", "budget", null, null, "budget_wait"],
  ["RUNNING", "human", "something_new", null, "person_wait"],
  ["REVIEW", "outbound", "push_pending", null, "delivering_review"],
  ["RUNNING", "outbound", "pr_pending", null, "delivering"],
  ["NEW", "none", null, null, "triaging"],
  ["READY", "none", null, null, "specced"],
  ["RUNNING", "none", null, null, "implementing"],
  ["REVIEW", "none", null, null, "reviewing"],
];

const input = ([stage, blocked_on, blocked_reason, close_reason]: Row) => ({ stage, blocked_on, blocked_reason, close_reason });

describe("phaseOf", () => {
  for (const row of TABLE) {
    it(`${row[0]} ${row[1]} ${row[2] ?? "-"} ${row[3] ?? ""} → ${row[4]}`, () => expect(phaseOf(input(row))).toBe(row[4]));
  }

  it("has exactly one row for every rule it tells apart", () => {
    const hits = TABLE.map((row) => PHASE_RULES.indexOf(phaseRule(input(row))));
    const missing = PHASE_RULES.map((r, i) => (hits.includes(i) ? null : JSON.stringify(r))).filter((x) => x !== null);
    expect(missing).toEqual([]);
    expect(hits.filter((h, i) => hits.indexOf(h) !== i)).toEqual([]);
  });

  it("decides merge_pending and spec_pending by stage too", () => {
    expect(phaseOf({ stage: "RUNNING", blocked_on: "human", blocked_reason: "merge_pending", close_reason: null })).toBe("person_wait");
    expect(phaseOf({ stage: "REVIEW", blocked_on: "human", blocked_reason: "spec_pending", close_reason: null })).toBe("person_wait");
  });
});
