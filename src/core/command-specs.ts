import type { RunKind } from "./types.js";

/**
 * The item command table (design §4): the phases an item can be in for human commands, the state a command is
 * checked against, and one CommandSpec per command. src/core/commands.ts builds the parser, footers, help and
 * refusals from it and re-exports its public names, so callers keep importing src/core/commands.ts.
 */

/** Where an item is, as far as human commands are concerned. Derived from the item by `commandPhase`. */
export type CommandPhase =
  | "triaging"
  | "spec_pending"
  | "budget_checkpoint"
  | "max_revisions"
  | "implementing"
  | "dependency_hold"
  | "dependency_closed"
  | "phase_hold"
  | "floor_tier"
  /** A run whose role holds all three Rule of Two facts, waiting for a person's `/approve` (auto mode approved its spec). */
  | "rule_of_two"
  | "too_large"
  | "failed_implement"
  | "failed_review"
  | "failed_run"
  | "agent_needs_human"
  | "repeated_failure"
  /** Held because its run failed with a pattern whose fix is filed or keeps recurring (design 05-alarms). */
  | "recurring_failure"
  | "reviewing"
  | "merge_pending"
  | "max_loops"
  | "merge_conflict"
  | "session_released"
  | "other_blocked"
  /** CLOSED with its PR merged: only a `/verdict` still applies (design §4). */
  | "merged"
  | "closed";

export const COMMAND_PHASES: readonly CommandPhase[] = [
  "triaging", "spec_pending", "budget_checkpoint", "max_revisions", "implementing", "dependency_hold", "dependency_closed", "phase_hold", "floor_tier", "rule_of_two", "too_large",
  "failed_implement", "failed_review", "failed_run", "agent_needs_human", "repeated_failure", "recurring_failure", "reviewing", "merge_pending", "max_loops", "merge_conflict", "session_released", "other_blocked", "merged", "closed",
];

export const OPEN_PHASES = COMMAND_PHASES.filter((p) => p !== "closed" && p !== "merged");
/** Open items and merged ones: where a `/verdict` applies. */
export const VERDICT_PHASES = COMMAND_PHASES.filter((p) => p !== "closed");

/** What the human can do depends on the phase and, for `/verdict`, on whether a PR exists yet or the item is local. */
export interface CommandState {
  phase: CommandPhase;
  has_pr: boolean;
  /** A local item: it takes a `/verdict` with no PR, judged on the item itself (design §4). Absent: not local. */
  local?: true;
  /**
   * `asked_by`, at `agent_needs_human`: the kind of run that asked (read from the item's runs; the fields cannot tell a resolve block from an implement block).
   * `merge_check`, at `max_loops`: a failed merge check stopped it (mergeCheckStopped): no `/retry`, `factory merge <id>` checks it again. Absent: not known.
   */
  asked_by?: RunKind; merge_check?: true;
}

export type CommandName = "approve" | "reject" | "revise" | "retry" | "resolve" | "paths" | "hold" | "note" | "budget" | "verdict" | "standing" | "link" | "help";

export interface CommandSpec {
  name: CommandName;
  /** As typed, e.g. `/approve [notes]`. */
  usage: string;
  /** One line. */
  description: string;
  /** Phases where the controller accepts it. */
  phases: readonly CommandPhase[];
  /** Also needs the item to have a PR, unless it is a local item. */
  needs_pr: boolean;
  /** Whether applying it can change the item's stage or block. */
  changes_state: boolean;
  /**
   * Phases where it is also accepted as a comment on the item's change, with the meaning in
   * `pr_description` (design §4). Absent: on the PR it means what it means on the issue, if it is read there.
   */
  pr_phases?: readonly CommandPhase[];
  /** One line: what it does on the PR. */
  pr_description?: string;
  /** Phases where it also applies to a local item with no PR, with the meaning in `local_description` (issue #563). */
  local_phases?: readonly CommandPhase[];
  local_description?: string;
  /** What it means in the `implementing` or the `triaging` phase, when that differs (`/revise` queued, design 04-gate-commands; added context, 02-attachments). */
  implementing_description?: string; triaging_description?: string;
  /** At `agent_needs_human`, it applies only when the run that asked was one of these kinds. Absent: any kind. */
  asked_by?: readonly RunKind[];
  table_note?: string; // what only the SET_UP.md table adds to `description`: the help replies keep to it (Slack's first section is full)
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "approve",
    usage: "/approve [notes]",
    description: "Approve the spec, the floor block or a run held for a person by the Rule of Two, or start an implement run held by coordination cost now (not one waiting for a dependency). Notes on the same line or below go to the implementer and the reviewer. " +
      "`/approve +paths <path>...` (at most 10, notes on the lines below) on the spec or the floor block also adds those paths to the allowed paths",
    table_note: "Over the size cap (a change too large, or a spec at its size checkpoint), `/approve <why>` needs a note saying why and approves a one-time cap; the dashboard's Approve opens a dialog for that note",
    // Also on an implement run held by coordination cost, never a dependency hold (design §5): not a phase here. At too_large only with a note (04-split-specs).
    phases: ["spec_pending", "max_revisions", "floor_tier", "rule_of_two", "too_large"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "reject",
    usage: "/reject <reason>",
    description:
      "Close the item at any open phase without a merge, giving your reason; its queued and running runs are stopped. " +
      "Not once its change is in the merge queue or merged: then it says why",
    // Any open phase (design 04-gate-commands, 2026-11-13); the controller refuses an item whose change is in the merge queue.
    phases: OPEN_PHASES,
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "revise",
    usage: "/revise <feedback>",
    description: "Get a new spec written with your feedback",
    // While implementing or triaging it is queued, not sent into the running session (design 04-gate-commands, 02-attachments).
    implementing_description: "While implementing: queue your feedback for one more implement run on the item's branch when the run ends, before review",
    triaging_description: "On a New or in-triage item: add context (the dashboard's Add context), queued, so one more triage run reads the filed text and your text when the current one ends",
    phases: ["triaging", "spec_pending", "implementing", "too_large", "failed_implement", "agent_needs_human", "repeated_failure", "max_loops"],
    needs_pr: false,
    changes_state: true,
    pr_phases: ["merge_pending", "failed_review"],
    pr_description: "On the PR: send your feedback to the implementer, who pushes a fix to the PR branch; a review runs after it",
    local_phases: ["merge_pending"],
    local_description: "On a local item with no PR: send your feedback to the implementer, who commits a fix to the item's local branch; a review runs after it",
  },
  {
    name: "retry",
    usage: "/retry",
    description:
      "Run the failed run again. Notes on the same line or below go to the implementer and the reviewer. " +
      "`/retry +paths <path>...` (at most 10, notes on the lines below) after a failed implement or resolve run also adds those paths to the allowed paths; a resolve run gets the notes without the `+paths` line. " +
      "At a dependency closed without a merge, it reads the dependencies again and starts the implement run if none is still closed. " +
      "At the review loop limit, it starts an implement run with the loop count reset; `+paths` applies there too. " +
      "On an item held for a recurring failure, it lifts the hold so the item's queued runs start; with `+paths` after a failed implement run, it adds the paths and starts a fresh implement run from the kept work instead. On a held phase of a split, it releases the phase into triage once the previous phase closed without a merge. After an interactive session ended without a PR, it queues the implement run (which a new `interactive start` can take over); `+paths` applies there too",
    // At a dependency closed unmerged it reads the dependencies again (design §5); at a phase hold it releases the phase unless the previous one is open (design 04-split-specs).
    phases: ["failed_run", "failed_review", "too_large", "failed_implement", "agent_needs_human", "repeated_failure", "dependency_closed", "max_loops", "recurring_failure", "phase_hold", "session_released"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "resolve",
    usage: "/resolve [notes]",
    description:
      "Let an agent resolve the PR's merge conflict; notes go to the agent. " +
      "`/resolve +paths <path>...` (at most 10, notes on the lines below) also adds those paths to the allowed paths",
    // Also the answer to a resolve run that asked for a human: the reply is the next resolve run's notes.
    phases: ["merge_conflict", "agent_needs_human"],
    asked_by: ["resolve"],
    needs_pr: false,
    changes_state: true,
  },
  { name: "paths", usage: "/paths +<path>...", phases: ["implementing", "failed_implement", "too_large", "session_released"], needs_pr: false, changes_state: true, // any RUNNING item: the controller checks the stage (design 05-interactive-sessions)
    description: "Add paths to the allowed paths of an item being implemented, in place: an interactive session's finish checks the new list, and a worker implement run takes it at its next attempt. At most 10, each with `+` before it, notes on the lines below. It never removes a path" },
  { name: "hold", usage: "/hold <id>", phases: [], local_phases: ["agent_needs_human"], asked_by: ["implement"], needs_pr: false, changes_state: true, // a local implement stop; a queued implement run is checked by the coordination unit from the item's runs (design 05-dependencies)
    description: "Hold until <id> merges: writes a `Depends on: <id>` line in the item's problem and queues the implement run, which waits for <id> (a local wi_… item or its short ID, or a built task tk_…) to merge and then starts on its own. Refused for an ID that names no local item, the item itself, or an item already merged", table_note: "Also on a local item whose implement run is queued and not started (`factory hold <item> <id>`): it writes the line and the queued run waits the same way. While the run is running it is refused, and applies once the run ends" },
  { name: "note", usage: "/note <text>", phases: OPEN_PHASES, needs_pr: false, changes_state: false, // an `owner_note` state change (src/controller/units/commands/note.ts)
    description: "Add a note for the item's reviewer and implementer, such as the reason a done-when line is built differently; their next run shows it under the approver's notes. It changes no state" },
  { name: "budget", usage: "/budget [tokens]", phases: ["budget_checkpoint"], needs_pr: false, changes_state: true,
    description: "Continue past the budget checkpoint with the suggested budget, or with a larger whole number of tokens" },
  {
    name: "verdict",
    usage: "/verdict accept|changes|reject <severity> <reason>",
    description:
      "Record a verdict on the result, also after the merge; it does not change the state. `/verdict accept` alone (or `yes`, `ok`) records severity `none`; " +
      "it replaces the verdict the factory recorded for the PR's head from a merge or a push",
    phases: VERDICT_PHASES,
    needs_pr: true,
    changes_state: false,
  },
  {
    name: "standing",
    usage: "/standing [accept|decline <rule>]",
    description:
      "Show the standing-approval rules, or turn one on or off. `/standing accept spec-t1` lets tier 1 specs that wait at the spec gate be approved without a reply; " +
      "`/standing decline spec-t1` turns it off or declines its proposal. A `/revise` or `/reject` on an item the rule approved also turns it off",
    phases: COMMAND_PHASES,
    needs_pr: false,
    changes_state: false,
  },
  {
    name: "link",
    usage: "/link <code>",
    description: "Link the account you post from to a factory user, with a code from `factory link-code <user_id>`",
    phases: COMMAND_PHASES,
    needs_pr: false,
    changes_state: false,
  },
  {
    name: "help",
    usage: "/help",
    description: "List every command and which ones apply now",
    phases: COMMAND_PHASES,
    needs_pr: false,
    changes_state: false,
  },
];

export const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
export const commandSpec = (name: CommandName): CommandSpec => BY_NAME.get(name)!;
