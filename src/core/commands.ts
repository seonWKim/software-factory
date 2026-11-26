import { COMMAND_TABLE, type CommandWho, cliHelpLine } from "./command-table.js";
import { LOCAL_SOURCE } from "./local-merge.js";
import { type TriageOutput, parseTriage } from "./outputs.js";
import { type ItemPhase, isClosedPhase, phaseOf } from "./phase.js";
import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE, SESSION_RELEASED, blockingRunKind } from "./policy.js";
import { SCHEDULE_CHECKPOINT } from "./schedule.js"; import type { Run, RunKind, WorkItem } from "./types.js";
import { MERGE_CHECK_HELP_LINE, awaitingSpec } from "./request-transition.js";
export * from "./request-transition.js"; export { settleHeldSkillVersion } from "./skill-eval-gate.js"; export { AT_TRIAGE, type Attachment, addedContext, attachmentLine } from "./attachments.js"; // the gates' shared checks (design 04-gate-commands); added context and attachments, for triage (02-attachments)

/**
 * The human commands on a work item (design §4): one table of names, usage, descriptions and the states
 * each applies in, plus a pure parser for comment bodies. Footers, `/help` replies (issue comments, Slack, `factory help`),
 * unknown-command replies, refusals and the SET_UP.md command table are all built here, so they cannot drift from each other.
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

const OPEN_PHASES = COMMAND_PHASES.filter((p) => p !== "closed" && p !== "merged");
/** Open items and merged ones: where a `/verdict` applies. */
const VERDICT_PHASES = COMMAND_PHASES.filter((p) => p !== "closed");

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

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
export const commandSpec = (name: CommandName): CommandSpec => BY_NAME.get(name)!;

/** blocked_reason prefix (with `blocked_on: human`) of an item whose dependency closed without a merge (design §5). */
export { DEPENDENCY_CLOSED } from "./phase.js"; export { LOCAL_SOURCE, MERGE_COMMAND, RESTART_COMMAND } from "./local-merge.js"; export { COORDINATOR_LIMIT_KEY, LIMIT_ALERTS_SCAN, coordinatorLimitAnswer } from "./spend.js"; // for the commands unit; the last: the coordinator limit answer (design 06-spend)
export { LOCAL_ID, dependsOnId, dependsOnIds, localItemOf, wantedDependsOn, withDependsOn } from "./task-build.js"; // for `/hold` and the coordination unit
export { CANCEL_APP_COMMAND, SENTENCE_APP_COMMAND, localIdentity } from "./local-cli.js"; export { specKind } from "./standing.js"; export { overCap } from "./split.js"; export { overCapApproval } from "./size-cap.js"; // for the commands unit; the last two: an over-cap `/approve` (design 04-split-specs)

/** Block reasons whose step `/retry` reads from the stage (or, for the agent blocks, from the item's runs first). */
const STAGE_RETRY_REASONS: readonly (string | null)[] = ["max_attempts", "max_restart", AGENT_NEEDS_HUMAN, REPEATED_FAILURE];

/**
 * The kind of run a human `/retry` would restart, or undefined if the item is not blocked by a failed run. For
 * `agent_needs_human` and `repeated_failure` this is the stage's step; the controller reads the run that blocked
 * first (`blockingRunKind`), since a resolve block has an implement block's stage.
 */
export function failedRunKind(it: WorkItem): RunKind | undefined {
  if (it.blocked_reason === SESSION_RELEASED) return it.stage === "RUNNING" ? "implement" : undefined; // the run a released session replaced
  const kind = it.blocked_reason?.match(/^run_failed:(triage|implement|review|update):/)?.[1] as RunKind | undefined;
  if (kind) return kind;
  if (!STAGE_RETRY_REASONS.includes(it.blocked_reason)) return undefined;
  if (it.stage === "NEW") return "triage";
  if (it.stage === "RUNNING") return "implement";
  if (it.stage === "REVIEW") return "review";
  return undefined;
}

type ItemState = Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "change_ref"> & Partial<Pick<WorkItem, "merge_sha" | "source" | "close_reason">>;

/** The item phases that are a command phase of the same name; READY with nothing blocking is `implementing`, any other open phase `other_blocked`. */
const SAME: ReadonlySet<ItemPhase> = new Set<Extract<ItemPhase, CommandPhase>>([
  "budget_checkpoint", "floor_tier", "rule_of_two", "agent_needs_human", "repeated_failure", "recurring_failure", "dependency_closed", "too_large",
  "failed_implement", "failed_review", "failed_run", "spec_pending", "max_revisions", "merge_pending", "max_loops", "merge_conflict", "dependency_hold",
  "phase_hold", "session_released", "triaging", "implementing", "reviewing",
]);
const isCommandPhase = (p: ItemPhase): p is Extract<ItemPhase, CommandPhase> => SAME.has(p);

/** The command phase of an item, from its phase (core/phase.ts). */
export function commandPhase(it: ItemState): CommandPhase {
  const p = phaseOf({ close_reason: null, ...it });
  if (isClosedPhase(p)) return it.merge_sha ? "merged" : "closed";
  return isCommandPhase(p) ? p : p === "specced" ? "implementing" : "other_blocked";
}

/** `askedBy`: at `agent_needs_human`, the kind of run that asked (see CommandState.asked_by). */
export function commandState(it: ItemState, askedBy?: RunKind, mergeCheck = false): CommandState {
  const phase = commandPhase(it);
  return {
    phase, has_pr: it.change_ref !== null, ...(it.source?.type === LOCAL_SOURCE ? { local: true as const } : {}),
    ...(phase === "agent_needs_human" && askedBy ? { asked_by: askedBy } : {}), ...(phase === "max_loops" && mergeCheck ? { merge_check: true as const } : {}),
  };
}

/** The command state of `it` read with its runs (the kind of run that asked at agent_needs_human), as the controller reads it. */
export function itemCommandState(it: ItemState, runs: readonly Run[]): CommandState {
  return commandState(it, blockingRunKind(it.blocked_reason, runs));
}

/** Whether `c` applies to the local item with no PR in `s` with its local meaning (`local_phases`, issue #563). */
export const appliesLocally = (c: CommandSpec, s: CommandState): boolean => s.local === true && !s.has_pr && (c.local_phases?.includes(s.phase) ?? false);

export function applies(c: CommandSpec, s: CommandState): boolean {
  const asked = (s.phase !== "agent_needs_human" || !c.asked_by || (s.asked_by !== undefined && c.asked_by.includes(s.asked_by))) && !(c.name === "retry" && s.merge_check);
  return asked && (appliesLocally(c, s) || (c.phases.includes(s.phase) && (!c.needs_pr || s.has_pr || s.local === true)));
}

/** Whether `c` is accepted as a comment on the item's PR with its PR meaning (`pr_phases`); needs a PR. */
export function appliesOnPr(c: CommandSpec, s: CommandState): boolean {
  return s.has_pr && (c.pr_phases?.includes(s.phase) ?? false);
}

/** The commands with a PR meaning that apply on the item's PR in `s`, in table order. */
export function prCommandsFor(s: CommandState): CommandSpec[] {
  return COMMANDS.filter((c) => appliesOnPr(c, s));
}

/**
 * Account commands: about the person, not the item. Listed by `/help` and in the SET_UP.md table, never in an
 * item's footer, and read on any issue, work item or not (design 2026-11-01).
 */
const ACCOUNT_COMMANDS: readonly CommandName[] = ["link"];

/**
 * Factory commands: about the factory's rules, not the item (design 05-standing-approvals). Listed by `/help` and
 * in the SET_UP.md table, never in an item's footer; parsed like item commands and answered on a work item.
 */
const FACTORY_COMMANDS: readonly CommandName[] = ["standing"];

/** The commands that apply in `s`, in table order, each with the description it has there; `/help` always last. */
export function commandsFor(s: CommandState): CommandSpec[] {
  const shown = (c: CommandSpec) => c.name !== "help" && c.name !== "paths" && c.name !== "note" && !ACCOUNT_COMMANDS.includes(c.name) && !FACTORY_COMMANDS.includes(c.name); // `/paths`, `/note`: in `/help`, no footer or page button yet
  const own = (c: CommandSpec) => appliesLocally(c, s) || (s.phase === "implementing" && c.implementing_description) || (s.phase === "triaging" && c.triaging_description);
  return COMMANDS.filter((c) => shown(c) && applies(c, s)).map((c) => (own(c) ? { ...c, description: meaning(c, s) } : c)).concat(commandSpec("help"));
}

/** What `c` does in `s`: its local meaning where that applies (issue #563), else every meaning it has (`s` null: the table). */
function meaning(c: CommandSpec, s: CommandState | null): string {
  if (s !== null && appliesLocally(c, s) && c.local_description) return c.local_description;
  if (s?.phase === "implementing" && c.implementing_description) return c.implementing_description;
  if (s?.phase === "triaging" && c.triaging_description) return c.triaging_description;
  return [c.description, c.implementing_description, c.pr_description, c.local_description, c.triaging_description].filter((d) => d).join(". ");
}

/** One command with its full description: Slack's help in an item's thread. */
const line = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.description}.`;
/** One command as a footer shows it: its first sentence only; the footer's last line, `/help`, gives the rest. */
const footerLine = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.description.split(/\.\s+(?=[A-Z`])/)[0]}.`;
const prLine = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.pr_description ?? c.description}.`;

/**
 * The commands that apply now, then a note when none of them changes the state. Ends every waiting comment.
 * When a command applies on the item's PR with its PR meaning, a block naming it comes first; the list and
 * the note after it are about replies on the comment's own issue. `except`: commands left out (#586).
 */
export function commandFooter(s: CommandState, except: readonly CommandName[] = []): string {
  const cmds = commandsFor(s).filter((c) => !except.includes(c.name));
  const onPr = prCommandsFor(s);
  const out = onPr.length ? ["On the change, you can reply with:", ...onPr.map(prLine), ""] : [];
  out.push("Commands you can reply with now:", ...cmds.map(footerLine));
  if (!cmds.some((c) => c.changes_state)) out.push("No command changes this item's state now.");
  return out.join("\n");
}

/** The reply to an unknown command word (as typed, letters only). */
export function unknownCommandReply(word: string, s: CommandState): string {
  return [`Unknown command "/${word}".`, "", commandFooter(s)].join("\n");
}

/**
 * The `/help` reply: every command, the ones that apply now marked. `factory help <id>` prints the same text; with no
 * item (`s` null, `factory help`) nothing is marked and the reply says how to see what applies to one item.
 */
export function helpReply(s: CommandState | null): string {
  return [
    "## Factory commands",
    "",
    s === null
      ? "Reply `/help` on a work item, or run `factory help <id>`, to see which commands apply to it now."
      : `Commands marked **(now)** apply to this item in its current state (${phaseLabel(s.phase)}).`,
    "",
    ...COMMANDS.map((c) => {
      const now = s === null ? "" : applies(c, s) ? " **(now)**" : appliesOnPr(c, s) ? " **(now, on the PR)**" : "";
      return `- \`${c.usage}\`${now}: ${meaning(c, s)}.`;
    }), ...(s?.merge_check ? [MERGE_CHECK_HELP_LINE] : []),
    "",
    cliHelpLine(),
  ].join("\n");
}

const PHASE_LABELS: Record<CommandPhase, string> = {
  triaging: "triaging", spec_pending: "spec waiting for approval", budget_checkpoint: "paused at a budget checkpoint", max_revisions: "spec at the revision limit", implementing: "implementing",
  dependency_hold: "waiting for a dependency to merge", dependency_closed: "blocked: a dependency was closed without a merge", floor_tier: "blocked by the floor check",
  rule_of_two: "waiting for a person to approve its run (Rule of Two)", too_large: "blocked: the change was too large", failed_implement: "blocked by a failed implement run",
  failed_review: "blocked by a failed review run", failed_run: "blocked by a failed run", agent_needs_human: "blocked: the agent asked for a human",
  repeated_failure: "blocked: a run failed the same way twice", recurring_failure: "held: its run failed like a known recurring failure", reviewing: "in review", merge_pending: "waiting for a human merge",
  max_loops: "review loop limit reached", merge_conflict: "PR has a merge conflict", session_released: "released: its session ended without a PR", other_blocked: "blocked for another reason",
  merged: "merged", closed: "closed", phase_hold: "held: waiting for the previous phase of its split",
};

/** The phase in the words the owner sees: `/help`, the command table and every refusal use it, never a stage name. */
export function phaseLabel(p: CommandPhase): string {
  return PHASE_LABELS[p];
}

function whenText(c: CommandSpec): string {
  const all = (ps: readonly CommandPhase[]) => ps.length === c.phases.length && ps.every((p) => c.phases.includes(p));
  const where = all(COMMAND_PHASES)
    ? "any time"
    : all(OPEN_PHASES)
      ? "any open item"
      : all(VERDICT_PHASES)
        ? "any open or merged item"
        : c.phases.map((p) => PHASE_LABELS[p]).join(", ");
  const on = (label: string, ps?: readonly CommandPhase[]) => (ps?.length ? `; ${label}: ${ps.map((p) => PHASE_LABELS[p]).join(", ")}` : "");
  // A command that applies only to a local item (`phases` empty) starts with its local phases.
  return ((c.needs_pr ? `${where}, once it has a PR (a local item needs none)` : where) + on("on a local item with no PR", c.local_phases) + on("on its PR", c.pr_phases)).replace(/^; /, "");
}

/** The command table in SET_UP.md, generated from COMMANDS; a test keeps the two equal. */
export function commandTableMarkdown(): string {
  return [
    "| Command | What it does | Applies when |",
    "|---|---|---|",
    ...COMMANDS.map((c) =>
      `| \`${c.usage.replace(/\|/g, "\\|")}\` | ${[meaning(c, null), c.table_note].filter((d) => d).join(". ")} | ${whenText(c)} |`),
  ].join("\n");
}

/** A parsed comment: a known command with the text after it, an unknown command word, or nothing. */
export type ParsedComment =
  | { kind: "command"; name: CommandName; text: string }
  | { kind: "unknown"; word: string }
  | null;

/**
 * Parses the first line of a comment. A command word is `/` plus letters (any case), followed by
 * whitespace, the end of the line, or one of `.,:;!?`; anything else is not a command. `text` is the
 * same-line text after the word and the following lines, joined by a newline and trimmed.
 */
export function parseComment(body: string): ParsedComment {
  const [first = "", ...rest] = body.trim().split(/\r?\n/);
  const m = /^\/([A-Za-z]+)(?=$|[\s.,:;!?])/.exec(first.trim());
  if (!m) return null;
  const word = m[1]!;
  const name = word.toLowerCase();
  if (!BY_NAME.has(name as CommandName)) return { kind: "unknown", word };
  // An account command is not an item command: sources pass it on as a plain comment, read by parseLink.
  if (ACCOUNT_COMMANDS.includes(name as CommandName)) return null;
  const same = first.trim().slice(m[0].length).replace(/^[.,:;!?]/, "").trim();
  return { kind: "command", name: name as CommandName, text: [same, ...rest].join("\n").trim() };
}

/** The most paths one `+paths` names (design §4, issue #280). */
export const MAX_COMMAND_PATHS = 10;

const PATHS_FLAG = /^\+paths(?=$|\s)/;

/** Why a `+paths` path is refused, or null when it is a repo-relative path with no `..` and no glob. */
export function commandPathProblem(p: string): string | null {
  if (p === "") return "an empty path";
  if (/^[/\\~]/.test(p) || /^[A-Za-z]:/.test(p)) return "an absolute path";
  if (p.split(/[/\\]/).includes("..")) return "a path with `..`";
  if (/[*?[\]{}!]/.test(p)) return "a glob";
  return null;
}

/**
 * Splits `+paths <path>...` off the text after `command` (`/approve`, `/retry` or `/resolve`; issue #280): the flag starts the first
 * line, the paths are the rest of it (in backticks or not, a leading `./` dropped), the note the lines below. No flag: the text is the
 * note, unless a first-line `+` word has a `/` or `.`, refused with the corrected command (design 04-gate-commands). Refused: no paths,
 * over MAX_COMMAND_PATHS, an empty, absolute, `..` or glob path. Duplicates dropped; coverage against allowed_paths is the caller's.
 */
export function parseCommandPaths(text: string, command = "/retry"): { paths: string[]; note: string } | { refuse: string } {
  const [first = "", ...rest] = text.trim().split(/\r?\n/);
  const m = PATHS_FLAG.exec(first.trim());
  const clean = (t: string) => t.replace(/^`([^`]*)`$/, "$1").replace(/^(\.\/)+/, "");
  if (!m) {
    const missed = first.trim().split(/\s+/).filter((t) => /^\+\S*[/.]/.test(t)).map((t) => clean(t.slice(1)));
    if (missed.length === 0) return { paths: [], note: text.trim() };
    const fix = retryPathsReply(missed, command);
    return { refuse: `a path on the first line needs \`+paths\` before it, so nothing changed; ${fix ? `did you mean \`${fix}\`?` : `the usage is \`${command} +paths <path>...\``}` };
  }
  const tokens = first.trim().slice(m[0].length).split(/\s+/).filter((t) => t !== "").map(clean);
  if (tokens.length === 0) return { refuse: "`+paths` needs at least one path after it on the same line, e.g. `+paths src/core/x.ts`" };
  if (tokens.length > MAX_COMMAND_PATHS) return { refuse: `\`+paths\` takes at most ${MAX_COMMAND_PATHS} paths per command, not ${tokens.length}` };
  for (const t of tokens) {
    const problem = commandPathProblem(t);
    if (problem) return { refuse: `\`+paths\` takes repo-relative paths only, and ${t === "" ? "one" : `\`${t}\``} is ${problem}` };
  }
  return { paths: [...new Set(tokens)], note: rest.join("\n").trim() };
}

/** The exact `<command> +paths ...` reply that allows `paths`, or null: none, over MAX_COMMAND_PATHS, or a path the parser would refuse or split. */
export function retryPathsReply(paths: readonly string[], command = "/retry"): string | null {
  const unique = [...new Set(paths)];
  if (unique.length === 0 || unique.length > MAX_COMMAND_PATHS) return null;
  if (unique.some((p) => commandPathProblem(p) !== null || /[\s`]/.test(p) || p.startsWith("./"))) return null;
  return `${command} +paths ${unique.join(" ")}`;
}

/** An agent's text without its own `/retry +`, `/approve +`, `/resolve +` or `/paths +` lines: only the controller's reply is shown. */
export const withholdReplyLines = (text: string): string =>
  text.split(/\r?\n/).filter((l) => !/\/(?:retry|approve|resolve|paths)\s+\+/i.test(l)).join("\n").trim() || "(withheld: a reply command the agent wrote)";

/**
 * `/link <code>` (design 2026-11-01): the code, or "" when the line has none. Null for any other comment. The
 * code is a secret until used: callers never log or echo it.
 */
export function parseLink(body: string): string | null {
  const first = body.trim().split(/\r?\n/)[0]!.trim();
  const m = /^\/link(?=$|[\s.,:;!?])[.,:;!?]?\s*(\S*)/i.exec(first);
  return m ? m[1]! : null;
}

/** The bot as chat help names it (the Slack app's name, scripts/slack-app.sh). */
export const CHAT_BOT = "@software-factory";

/**
 * The chat `help` reply: only the commands the sender may run in that place. `may` says whether the sender's role
 * allows an action; `state` is the item's when asked in its thread, else null. Outside an item's thread: the
 * reads, the request that starts work, and `/link` (there a bare `link` would be a request). In an item's thread: the
 * reads, `merge` when it applies, and the item's commands that apply now, each with its full description for that
 * state (issue #528) shown without its `/` (chatForm, issue #541), as typed after the mention there. Writes refused in
 * chat (`edge`) are never listed, nor the schedule commands: the reply's first Slack section is full (SET_UP.md lists them).
 */
export function chatHelpReply(may: (w: CommandWho) => boolean, state: CommandState | null): string {
  const lines: string[] = [];
  for (const c of COMMAND_TABLE) {
    if (c.edge || !may(c.who) || c.group === "schedule") continue;
    if (c.chat_args === "request" && state !== null) continue;
    if (c.item && (c.name !== "merge" || (state?.phase !== "merge_pending" && !state?.merge_check))) continue;
    lines.push(`- \`${c.chat}\`: ${c.does}.`);
  }
  const now = state !== null && may("approve_spec") ? commandsFor(state).filter((c) => c.name !== "help") : [];
  lines.push(...now.map((c) => chatForm(line(c))));
  if (state === null) lines.push(line(commandSpec("link")));
  lines.push(`- \`help\`: ${commandSpec("help").description}.`);
  const where = state === null ? "here" : "in this item's thread";
  return [`Commands you can run ${where} (mention the bot first, e.g. \`${CHAT_BOT} help\`):`, ...lines].join("\n");
}

/**
 * Commands a chat source reads without their `/` after a mention, in an item's thread only (issues #528, #541): every
 * command but `help`, which is read bare anywhere. Outside an item's thread the same words are a request in plain words.
 */
export const THREAD_BARE_COMMANDS: readonly CommandName[] = COMMANDS.map((c) => c.name).filter((n) => n !== "help");

/**
 * `text` with its `/` added when it starts with one of the bare command words `names`, else null. The default, `approve`
 * alone, is issue #528's first bare word; the Slack source passes THREAD_BARE_COMMANDS.
 */
export function withSlash(text: string, names: readonly CommandName[] = ["approve"]): string | null {
  const t = text.trim();
  const m = /^([A-Za-z]+)(?=$|[\s.,:;!?])/.exec(t);
  return m && names.includes(m[1]!.toLowerCase() as CommandName) ? `/${t}` : null;
}

const SLASHED = new RegExp(`(^|[\\s\`(])/(${COMMANDS.map((c) => c.name).join("|")})(?![A-Za-z])`, "g");

/** `s` with every command it names shown without its `/`, as typed after a mention in a chat thread (issue #541). */
export function chatForm(s: string): string {
  return s.replace(SLASHED, "$1$2");
}

/*
 * Refusals (issue #528): one text per reason, said the same way on every surface. The controller's reply on an issue
 * and in a Slack thread, the dashboard's stored reply and `factory approve`'s own check all build them here; the
 * dashboard shows them without backticks (web/src/api.ts plainRefusal), the stored text keeps them.
 */

/** A refused command as every surface says it: `` `/approve` was not applied: <reason>. `` */
export function refusalText(command: string, reason: string): string {
  return `\`${command}\` was not applied: ${reason}.`;
}

/** The reason for any command on a closed item. */
export const CLOSED_REFUSAL = "the work item is closed";

/** The reason for a spec command (or `/retry`) at a budget checkpoint. */
export const CHECKPOINT_REFUSAL = "the item is at a budget checkpoint; reply `/budget`, `/budget <tokens>` or `/reject <reason>`";

/** The reason for `/approve` on an item held for a dependency: `held` is its blocked_reason. */
export function dependencyHoldRefusal(held: string | null): string {
  return `the item is ${phaseLabel("dependency_hold")} (${held ?? "a dependency"}), and \`/approve\` does not lift a ` +
    "dependency hold: the implement run starts on its own once the dependency merges";
}

/** The reason for a spec command on an item whose spec is not waiting for approval. */
export function specNotWaiting(phase: CommandPhase): string {
  return `the spec is not waiting for approval (the item is ${phaseLabel(phase)})`;
}

/** The reason for `/approve` on a spec that changes no file in this repo (design 04-spec-gate-commands, 2026-11-20); the spec comment says it too. */
export const NO_FILES_REFUSAL = "the spec changes no file in this repo (its files_to_change is empty), so there is nothing to implement; reply `/revise <feedback>` for a spec that changes a file here, or `/reject <reason>` to close";
/** Whether `spec` changes no file in this repo: one spec (not a split) whose files_to_change is empty. */
export const changesNoFile = (spec: TriageOutput | null): boolean => spec !== null && !spec.phases && spec.files_to_change.length === 0;
/** NO_FILES_REFUSAL when `it` waits at the spec gate on a spec that changes no file, else null. The caller passes the runs. */
export const noFilesRefusal = (it: WorkItem, runs: readonly Run[]): string | null => (awaitingSpec(it) && changesNoFile(latestSpec(runs)) ? NO_FILES_REFUSAL : null);
/** The reason for `/retry +paths` on an item whose `/retry` re-checks its premise first (design 04-spec-gate-commands, 2026-11-20). */
export const RECHECK_PATHS_REFUSAL = "the item's last change is more than a day old, so `/retry` re-checks its premise with a new triage run first, and `+paths` does not apply to that; reply `/retry` without `+paths`, then `/approve +paths <path>...` on the new spec";

/**
 * Why `/approve` cannot apply to `it` whatever its runs say, in the controller's words; null when the controller may
 * apply it. Read from the item's fields only, so `factory approve` checks it before any store write (issue #528). An
 * implement run held by coordination cost (RUNNING, not blocked: the hold is in no field) and a split parent's states
 * are the controller's to decide, so they are null here.
 */
export function approveRefusal(it: ItemState): string | null {
  if (it.stage === "CLOSED") return CLOSED_REFUSAL;
  if (it.stage === "RUNNING" && it.blocked_on === "none") return null;
  if (it.blocked_reason === "budget_checkpoint") return CHECKPOINT_REFUSAL;
  if (it.blocked_reason === SCHEDULE_CHECKPOINT) return null; // the approve gate closes it (design 08-schedules)
  const s = commandState(it);
  if (applies(commandSpec("approve"), s)) return null; // at too_large, the controller's over-cap check decides (design 04-split-specs)
  if (it.stage === "READY" && (it.blocked_on === "upstream" || it.blocked_reason === "delivery_failed")) return null;
  if (it.blocked_on === "dependency") return dependencyHoldRefusal(it.blocked_reason);
  return specNotWaiting(s.phase);
}

/**
 * The spec an `/approve` answers (issue #526): the one the item's latest applied, successful triage run wrote, read
 * from the run's stored output; null when there is none or it no longer parses. Store reads only: the caller passes
 * the item's runs.
 */
export function latestSpec(runs: readonly Run[]): TriageOutput | null {
  const run = runs.filter((r) => r.kind === "triage" && r.outcome?.status === "succeeded" && r.acknowledged_at !== null).at(-1);
  if (run?.outcome?.status !== "succeeded") return null;
  const parsed = parseTriage(run.outcome.data.spec);
  return parsed.ok ? parsed.value : null;
}
