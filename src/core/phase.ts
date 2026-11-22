import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE, SESSION_RELEASED } from "./policy.js";
import { PHASE_HOLD, PHASES_OPEN } from "./split.js";
import { type BlockedOn, type CloseReason, RECURRING_FAILURE, type Stage, type WorkItem } from "./types.js";

/**
 * Where a work item stands (design 09-status-page, one rule for an item's phase): the one place that reads stage,
 * blocked_on, blocked_reason and close_reason to decide it. The status label (statusOf), the page level (levelOf),
 * the command phase (commandPhase), the notice kind (noticeKind) and the merge checks map from it. Pure.
 */
export type ItemPhase =
  | "done"
  | "closed"
  | "budget_checkpoint"
  | "floor_tier"
  | "rule_of_two"
  | "agent_needs_human"
  | "repeated_failure"
  | "recurring_failure"
  | "dependency_closed"
  | "dependency_cycle"
  | "too_large"
  | "failed_implement"
  | "failed_review"
  | "failed_run"
  | "spec_pending"
  | "max_revisions"
  | "merge_pending"
  | "max_loops"
  | "merge_conflict"
  | "session_released"
  | "dependency_hold"
  | "phase_hold"
  | "phases_open"
  | "upstream_wait"
  | "ci_wait"
  | "budget_wait"
  | "person_wait"
  | "delivering"
  | "delivering_review"
  | "triaging"
  | "specced"
  | "implementing"
  | "reviewing";

/** The item a person closed a dependency of without a merge: `dependency_closed:<ref>`. */
export const DEPENDENCY_CLOSED = "dependency_closed";
/** Its dependencies form a cycle: `dependency_cycle:<refs>`. */
export const DEPENDENCY_CYCLE = "dependency_cycle";

/** What phaseOf reads. */
export type PhaseInput = Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "close_reason">;

/**
 * One rule: the stage, the block, the reason and the close reason it matches (absent: any), and its phase.
 * `reason` matches the whole blocked_reason; one ending in `:*` matches that prefix. `close` matches close_reason.
 */
export interface PhaseRule {
  stage?: Stage;
  on?: BlockedOn;
  reason?: string;
  close?: CloseReason;
  phase: ItemPhase;
}

/** Failed-run reasons with no kind of their own: the stage says which run failed. */
const STAGE_FAILURES = (reason: string): PhaseRule[] => [
  { stage: "NEW", on: "human", reason, phase: "failed_run" },
  { stage: "RUNNING", on: "human", reason, phase: "failed_implement" },
  { stage: "REVIEW", on: "human", reason, phase: "failed_review" },
];

/** Every rule, first match wins. The last rule of each block matches any reason; the table test keys on each one. */
export const PHASE_RULES: readonly PhaseRule[] = [
  { stage: "CLOSED", close: "completed", phase: "done" },
  { stage: "CLOSED", phase: "closed" },
  // The gates a person answers, whatever the stage.
  { reason: "budget_checkpoint", phase: "budget_checkpoint" },
  { reason: "floor_tier", phase: "floor_tier" },
  { reason: "rule_of_two", phase: "rule_of_two" },
  { on: "human", reason: AGENT_NEEDS_HUMAN, phase: "agent_needs_human" },
  { on: "human", reason: REPEATED_FAILURE, phase: "repeated_failure" },
  { on: "human", reason: RECURRING_FAILURE, phase: "recurring_failure" },
  { on: "human", reason: `${DEPENDENCY_CLOSED}:*`, phase: "dependency_closed" },
  { on: "human", reason: `${DEPENDENCY_CYCLE}:*`, phase: "dependency_cycle" },
  { on: "human", reason: "run_failed:implement:diff_too_large", phase: "too_large" },
  { on: "human", reason: "run_failed:implement:*", phase: "failed_implement" },
  { on: "human", reason: "run_failed:review:*", phase: "failed_review" },
  { on: "human", reason: "run_failed:triage:*", phase: "failed_run" },
  { on: "human", reason: "run_failed:update:*", phase: "failed_run" },
  ...STAGE_FAILURES("max_attempts"),
  ...STAGE_FAILURES("max_restart"),
  { stage: "READY", on: "human", reason: "spec_pending", phase: "spec_pending" },
  { stage: "READY", reason: "max_revisions", phase: "max_revisions" },
  { stage: "REVIEW", on: "human", reason: "merge_pending", phase: "merge_pending" },
  { reason: "max_loops", phase: "max_loops" },
  { reason: "merge_conflict_pending", phase: "merge_conflict" },
  // An interactive session ended without a PR (abandoned or its lease lost): `/retry` queues the implement run.
  { stage: "RUNNING", on: "human", reason: SESSION_RELEASED, phase: "session_released" },
  // Waits on something other than a person.
  { on: "dependency", phase: "dependency_hold" },
  { on: "upstream", reason: PHASE_HOLD, phase: "phase_hold" },
  { on: "upstream", reason: PHASES_OPEN, phase: "phases_open" },
  { on: "upstream", phase: "upstream_wait" },
  { on: "ci", phase: "ci_wait" },
  { on: "budget", phase: "budget_wait" },
  { on: "human", phase: "person_wait" },
  { stage: "REVIEW", on: "outbound", phase: "delivering_review" },
  { on: "outbound", phase: "delivering" },
  // Nothing blocks it: its stage.
  { stage: "NEW", phase: "triaging" },
  { stage: "READY", phase: "specced" },
  { stage: "RUNNING", phase: "implementing" },
  { stage: "REVIEW", phase: "reviewing" },
];

function reasonMatches(want: string | undefined, got: string | null): boolean {
  if (want === undefined) return true;
  if (got === null) return false;
  return want.endsWith(":*") ? got.startsWith(want.slice(0, -1)) : got === want;
}

/** True when `r` matches the item. */
function ruleMatches(r: PhaseRule, it: PhaseInput): boolean {
  return (r.stage === undefined || r.stage === it.stage) &&
    (r.on === undefined || r.on === it.blocked_on) &&
    (r.close === undefined || r.close === it.close_reason) &&
    reasonMatches(r.reason, it.blocked_reason);
}

/** The rule that decides the item's phase. Every item matches one: the last four cover every open stage. */
export function phaseRule(it: PhaseInput): PhaseRule {
  return PHASE_RULES.find((r) => ruleMatches(r, it))!;
}

/** The item's phase: the one rule for its state. */
export function phaseOf(it: PhaseInput): ItemPhase {
  return phaseRule(it).phase;
}

/** The phases where the item waits for a person (or the budget check) to act. */
export const PERSON_PHASES: ReadonlySet<ItemPhase> = new Set<ItemPhase>([
  "budget_checkpoint", "floor_tier", "rule_of_two", "agent_needs_human", "repeated_failure", "recurring_failure",
  "dependency_closed", "dependency_cycle", "too_large", "failed_implement", "failed_review", "failed_run",
  "spec_pending", "max_revisions", "merge_pending", "max_loops", "merge_conflict", "session_released", "budget_wait", "person_wait",
]);

/** The phases of a failed run a person retries or rejects. */
export const FAILED_PHASES: ReadonlySet<ItemPhase> = new Set<ItemPhase>(["too_large", "failed_implement", "failed_review", "failed_run", "repeated_failure"]);

/** True for a closed item, merged or not. */
export const isClosedPhase = (p: ItemPhase): p is "done" | "closed" => p === "done" || p === "closed";
