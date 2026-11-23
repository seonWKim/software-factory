// The dashboard's sentence for each reason code of an item's wait (ui/why.ts ReasonCode), for `factory status`. The web
// app words a code from its own catalog (web/src/i18n/en/work.ts, `why.reason.<code>`); a feature may not import that
// file, so this table is the CLI's copy of it. `{name}` is filled from the row's values (`why.params`).

export const REASON_WORDS: Record<string, string> = {
  closed: "Closed",
  closed_as: "Closed: {reason}",
  budget: "Waiting for a person to answer the budget check",
  merge_pending: "Ready to merge: waiting for a person to merge the PR",
  spec_pending: "Waiting for a person to approve the spec",
  max_revisions: "The spec reached its revision limit: a person approves, revises or rejects it",
  dependency_closed: "{ref} was closed without a merge: a person decides how this item goes on",
  dependency_cycle: "Its dependencies form a cycle ({cycle}): a person removes one link",
  max_loops: "Too many review loops: a person decides what happens next",
  merge_conflict: "A merge conflict needs a person",
  recurring_none: "Held by a recurring failure; its runs hold no failed run to name it. A person retries it (/retry) or rejects it",
  recurring_stalled: "Held by a recurring failure. {failure}. The model stalled, so a plain retry is likely enough: /retry",
  recurring_rate_limited: "Held by a recurring failure. {failure}. A usage or rate limit stopped it, so a plain retry is likely enough: /retry",
  recurring_infra: "Held by a recurring failure. {failure}. The factory's own infrastructure failed, not the task, so a plain retry is likely enough: /retry",
  recurring_own: "Held by a recurring failure. {failure}. It is the task's own failure, so a plain retry will likely fail again: change the spec, the code or the setup first, then /retry",
  failed_triage: "Triage failed. {failure} Decide what happens next",
  failed_implement: "Building failed. {failure} Decide what happens next",
  failed_review: "Review failed. {failure} Decide what happens next",
  failed_update: "Bringing the change up to date failed. {failure} Decide what happens next",
  failed_step: "A step failed. {failure} Decide what happens next",
  repeated_triage: "Triage failed twice the same way. Decide what happens next",
  repeated_implement: "Building failed twice the same way. Decide what happens next",
  repeated_step: "A step failed twice the same way. Decide what happens next",
  agent_needs_human: "The agent asked a question: a person answers it",
  floor_tier: "The change touches a protected area: a person approves it",
  rule_of_two: "Held by the Rule of Two: a person approves the run before it starts",
  session_released: "The terminal session ended without a change: a person retries or rejects it",
  changes_requested: "Review found problems in a change a person opened: its author fixes them",
  empty_diff: "The change has nothing to review against the base: a person decides what happens next",
  delivery_failed: "Delivering the change failed: a person decides what happens next",
  checks_failed: "The change passed review but its checks failed: a person decides what happens next",
  checks_failed_update: "The checks failed and the branch conflicts with the base: it is brought up to date first",
  eval_regression: "The change made the factory's own test cases worse: a person decides what happens next",
  person_idle: "Waiting for a person: the item is {stage}; next, a person retries, resolves or rejects it",
  person_code: "Waiting for a person to decide what happens next",
  person: "Waiting for a person: {reason}",
  deadlock: "Running at the same time as \"{holder}\", which changes some of the same files. If they clash, you'll be asked when it merges.",
  deadlock_unknown: "Running at the same time as another item, which changes some of the same files. If they clash, you'll be asked when it merges.",
  running: "Running {kind}",
  paused_rate_limit: "Paused by a usage or rate limit until {until}",
  paused_model_stall: "Paused: the model is not answering; runs start again once a probe answers",
  paused_model_credential: "Waiting for a model credential",
  paused_forge_auth: "Paused: the forge refused the factory's credentials, until {until}",
  paused_preflight: "Paused: a push or PR access check failed, until {until}",
  dependency: "Waiting for {refs} to merge",
  dependency_unknown: "Waiting for another issue to merge",
  phase_parent_one: "Waiting for its phase {ref} to merge",
  phase_parent_many: "Waiting for its {count} open phases to merge",
  phase_parent: "Waiting for its phases to merge",
  phase_prev_ref: "Waiting for the previous phase {ref} to merge",
  phase_prev: "Waiting for the previous phase to merge",
  ci: "Waiting for CI",
  other_issue: "Waiting on another issue",
  held_running: "Held behind {holder}, which is running",
  held_pr: "Held behind {holder}, which has an open PR",
  held_waiting: "Held behind {holder}, which is queued ahead of it",
  not_before: "Retry waits until {until}",
  queued_at: "Queued at position {position}",
  queued: "Queued {kind}",
  waits_session: "Waits for a session: workers do not take {kind} runs",
  idle: "Nothing moves it: no run is queued",
};

/** The item's stage in words (`why.stage.<stage>` in the web catalog), for the `person_idle` sentence. */
const STAGE_WORDS: Record<string, string> = {
  NEW: "new, not triaged yet", READY: "specced, not started", RUNNING: "being built", REVIEW: "in review", CLOSED: "closed",
};

/** A reason code and its values in the dashboard's words; a value that is not text as the sentence needs it reads as it is, an unknown name as nothing. */
export function reasonWords(code: string, params: Readonly<Record<string, string | number>>): string {
  return (REASON_WORDS[code] ?? "").replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = String(params[name] ?? "");
    return name === "stage" ? (STAGE_WORDS[v] ?? v) : v;
  });
}
