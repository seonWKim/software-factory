import { cliHelpLine } from "./local-cli.js";
import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE } from "./policy.js";
import type { RunKind, WorkItem } from "./types.js";

/**
 * The human commands on a work item (design §4): one table of names, usage, descriptions and the states
 * each applies in, plus a pure parser for comment bodies. Footers, `/help` replies, unknown-command replies
 * and the SET_UP.md command table are all built from this table, so they cannot drift from each other.
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
  | "floor_tier"
  | "too_large"
  | "failed_implement"
  | "failed_review"
  | "failed_run"
  | "agent_needs_human"
  | "repeated_failure"
  | "reviewing"
  | "merge_pending"
  | "max_loops"
  | "merge_conflict"
  | "other_blocked"
  /** CLOSED with its PR merged: only a `/verdict` still applies (design §4). */
  | "merged"
  | "closed";

export const COMMAND_PHASES: readonly CommandPhase[] = [
  "triaging", "spec_pending", "budget_checkpoint", "max_revisions", "implementing", "dependency_hold", "dependency_closed", "floor_tier",
  "too_large",
  "failed_implement", "failed_review", "failed_run", "agent_needs_human", "repeated_failure", "reviewing", "merge_pending", "max_loops", "merge_conflict", "other_blocked", "merged", "closed",
];

const OPEN_PHASES = COMMAND_PHASES.filter((p) => p !== "closed" && p !== "merged");
/** Open items and merged ones: where a `/verdict` applies. */
const VERDICT_PHASES = COMMAND_PHASES.filter((p) => p !== "closed");

/** What the human can do depends on the phase and, for `/verdict`, on whether a PR exists yet. */
export interface CommandState {
  phase: CommandPhase;
  has_pr: boolean;
  /**
   * At `agent_needs_human`: the kind of run that asked (read from the item's runs; the item's fields cannot tell
   * a resolve block from an implement block). Absent when not known.
   */
  asked_by?: RunKind;
}

export type CommandName = "approve" | "reject" | "revise" | "retry" | "resolve" | "budget" | "verdict" | "standing" | "link" | "help";

export interface CommandSpec {
  name: CommandName;
  /** As typed, e.g. `/approve [notes]`. */
  usage: string;
  /** One line. */
  description: string;
  /** Phases where the controller accepts it. */
  phases: readonly CommandPhase[];
  /** Also needs the item to have a PR. */
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
  /** At `agent_needs_human`, it applies only when the run that asked was one of these kinds. Absent: any kind. */
  asked_by?: readonly RunKind[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "approve",
    usage: "/approve [notes]",
    description:
      "Approve the spec or the floor block, or start an implement run held by coordination cost now (not one waiting for a dependency). Notes on the same line or below go to the implementer and the reviewer. " +
      "`/approve +paths <path>...` (at most 10, notes on the lines below) on the spec or the floor block also adds those paths to the allowed paths",
    // Also accepted on an implement run held by coordination cost (design §5, 2026-11-03): that hold is not in the
    // item's fields, so it is no phase here; the hold comment names the command. Never on a dependency hold.
    phases: ["spec_pending", "max_revisions", "floor_tier"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "reject",
    usage: "/reject <reason>",
    description: "Close the item without a merge, giving your reason",
    phases: [
      "spec_pending", "max_revisions", "floor_tier", "budget_checkpoint", "too_large", "failed_implement", "agent_needs_human", "repeated_failure",
      "max_loops",
    ],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "revise",
    usage: "/revise <feedback>",
    description: "Get a new spec written with your feedback",
    phases: ["spec_pending", "too_large", "failed_implement", "agent_needs_human", "repeated_failure", "max_loops"],
    needs_pr: false,
    changes_state: true,
    pr_phases: ["merge_pending", "failed_review"],
    pr_description: "On the PR: send your feedback to the implementer, who pushes a fix to the PR branch; a review runs after it",
  },
  {
    name: "retry",
    usage: "/retry",
    description:
      "Run the failed run again. Notes on the same line or below go to the implementer and the reviewer. " +
      "`/retry +paths <path>...` (at most 10, notes on the lines below) after a failed implement run also adds those paths to the allowed paths. " +
      "At a dependency closed without a merge, it reads the dependencies again and starts the implement run if none is still closed. " +
      "At the review loop limit, it starts an implement run with the loop count reset; `+paths` applies there too",
    // At a dependency closed unmerged it reads the dependencies again and releases the item if they merged (design §5).
    phases: ["failed_run", "failed_review", "too_large", "failed_implement", "agent_needs_human", "repeated_failure", "dependency_closed", "max_loops"],
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
  {
    name: "budget",
    usage: "/budget [tokens]",
    description: "Continue past the budget checkpoint with the suggested budget, or with a larger whole number of tokens",
    phases: ["budget_checkpoint"],
    needs_pr: false,
    changes_state: true,
  },
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

export function commandSpec(name: CommandName): CommandSpec {
  return BY_NAME.get(name)!;
}

/** blocked_reason prefix (with `blocked_on: human`) of an item whose dependency closed without a merge (design §5). */
export const DEPENDENCY_CLOSED = "dependency_closed";

/** Block reasons whose step `/retry` reads from the stage (or, for the agent blocks, from the item's runs first). */
const STAGE_RETRY_REASONS: readonly (string | null)[] = ["max_attempts", "max_restart", AGENT_NEEDS_HUMAN, REPEATED_FAILURE];

/**
 * The kind of run a human `/retry` would restart, or undefined if the item is not blocked by a failed run. For
 * `agent_needs_human` and `repeated_failure` this is the stage's step; the controller reads the run that blocked
 * first (`blockingRunKind`), since a resolve block has an implement block's stage.
 */
export function failedRunKind(it: WorkItem): RunKind | undefined {
  const kind = it.blocked_reason?.match(/^run_failed:(triage|implement|review|update):/)?.[1] as RunKind | undefined;
  if (kind) return kind;
  if (!STAGE_RETRY_REASONS.includes(it.blocked_reason)) return undefined;
  if (it.stage === "NEW") return "triage";
  if (it.stage === "RUNNING") return "implement";
  if (it.stage === "REVIEW") return "review";
  return undefined;
}

type ItemState = Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "pr_number"> & Partial<Pick<WorkItem, "merge_sha">>;

/** The phase of an item; the same checks, in the same order, as the controller's command handling. */
export function commandPhase(it: ItemState): CommandPhase {
  if (it.stage === "CLOSED") return it.merge_sha ? "merged" : "closed";
  if (it.blocked_reason === "budget_checkpoint") return "budget_checkpoint";
  if (it.blocked_reason === "floor_tier") return "floor_tier";
  if (it.blocked_on === "human") {
    if (it.blocked_reason === AGENT_NEEDS_HUMAN) return "agent_needs_human";
    if (it.blocked_reason === REPEATED_FAILURE) return "repeated_failure";
    if (it.blocked_reason?.startsWith(`${DEPENDENCY_CLOSED}:`)) return "dependency_closed";
    const kind = failedRunKind(it as WorkItem);
    if (kind === "implement") return it.blocked_reason === "run_failed:implement:diff_too_large" ? "too_large" : "failed_implement";
    if (kind === "review") return "failed_review";
    if (kind) return "failed_run";
  }
  if (it.stage === "READY" && it.blocked_reason === "spec_pending") return "spec_pending";
  if (it.stage === "READY" && it.blocked_reason === "max_revisions") return "max_revisions";
  if (it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending") return "merge_pending";
  if (it.blocked_reason === "max_loops") return "max_loops";
  if (it.blocked_reason === "merge_conflict_pending") return "merge_conflict";
  if (it.blocked_on === "dependency") return "dependency_hold";
  if (it.blocked_on !== "none") return "other_blocked";
  if (it.stage === "NEW") return "triaging";
  if (it.stage === "REVIEW") return "reviewing";
  return "implementing";
}

/** `askedBy`: at `agent_needs_human`, the kind of run that asked (see CommandState.asked_by). */
export function commandState(it: ItemState, askedBy?: RunKind): CommandState {
  const phase = commandPhase(it);
  return { phase, has_pr: it.pr_number !== null, ...(phase === "agent_needs_human" && askedBy ? { asked_by: askedBy } : {}) };
}

export function applies(c: CommandSpec, s: CommandState): boolean {
  if (!c.phases.includes(s.phase) || (c.needs_pr && !s.has_pr)) return false;
  return s.phase !== "agent_needs_human" || !c.asked_by || (s.asked_by !== undefined && c.asked_by.includes(s.asked_by));
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

/** The commands that apply in `s`, in table order; `/help` always last. */
export function commandsFor(s: CommandState): CommandSpec[] {
  const shown = (c: CommandSpec) => c.name !== "help" && !ACCOUNT_COMMANDS.includes(c.name) && !FACTORY_COMMANDS.includes(c.name);
  return COMMANDS.filter((c) => shown(c) && applies(c, s)).concat(commandSpec("help"));
}

const line = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.description}.`;

const prLine = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.pr_description ?? c.description}.`;

/**
 * The commands that apply now, then a note when none of them changes the state. Ends every waiting comment.
 * When a command applies on the item's PR with its PR meaning, a block naming it comes first; the list and
 * the note after it are about replies on the comment's own issue.
 */
export function commandFooter(s: CommandState): string {
  const cmds = commandsFor(s);
  const onPr = prCommandsFor(s);
  const out = onPr.length ? ["On the change, you can reply with:", ...onPr.map(prLine), ""] : [];
  out.push("Commands you can reply with now:", ...cmds.map(line));
  if (!cmds.some((c) => c.changes_state)) out.push("No command changes this item's state now.");
  return out.join("\n");
}

/** The reply to an unknown command word (as typed, letters only). */
export function unknownCommandReply(word: string, s: CommandState): string {
  return [`Unknown command "/${word}".`, "", commandFooter(s)].join("\n");
}

/** The `/help` reply: every command, the ones that apply now marked. */
export function helpReply(s: CommandState): string {
  return [
    "## Factory commands",
    "",
    `Commands marked **(now)** apply to this item in its current state (${phaseLabel(s.phase)}).`,
    "",
    ...COMMANDS.map((c) => {
      const now = applies(c, s) ? " **(now)**" : appliesOnPr(c, s) ? " **(now, on the PR)**" : "";
      return `- \`${c.usage}\`${now}: ${c.description}${c.pr_description ? `. ${c.pr_description}` : ""}.`;
    }),
    "",
    cliHelpLine(),
  ].join("\n");
}

const PHASE_LABELS: Record<CommandPhase, string> = {
  triaging: "triaging",
  spec_pending: "spec waiting for approval",
  budget_checkpoint: "paused at a budget checkpoint",
  max_revisions: "spec at the revision limit",
  implementing: "implementing",
  dependency_hold: "waiting for a dependency to merge",
  dependency_closed: "blocked: a dependency was closed without a merge",
  floor_tier: "blocked by the floor check",
  too_large: "blocked: the change was too large",
  failed_implement: "blocked by a failed implement run",
  failed_review: "blocked by a failed review run",
  failed_run: "blocked by a failed run",
  agent_needs_human: "blocked: the agent asked for a human",
  repeated_failure: "blocked: a run failed the same way twice",
  reviewing: "in review",
  merge_pending: "waiting for a human merge",
  max_loops: "review loop limit reached",
  merge_conflict: "PR has a merge conflict",
  other_blocked: "blocked for another reason",
  merged: "merged",
  closed: "closed",
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
  const onPr = c.pr_phases?.length ? `; on its PR: ${c.pr_phases.map((p) => PHASE_LABELS[p]).join(", ")}` : "";
  return (c.needs_pr ? `${where}, once it has a PR` : where) + onPr;
}

/** The command table in SET_UP.md, generated from COMMANDS; a test keeps the two equal. */
export function commandTableMarkdown(): string {
  return [
    "| Command | What it does | Applies when |",
    "|---|---|---|",
    ...COMMANDS.map((c) =>
      `| \`${c.usage.replace(/\|/g, "\\|")}\` | ${c.description}${c.pr_description ? `. ${c.pr_description}` : ""} | ${whenText(c)} |`),
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
 * Splits `+paths <path>...` off the text after `/approve`, `/retry` or `/resolve` (design §4, issue #280). The flag starts
 * the text's first line; the paths are the rest of that line, separated by whitespace (a path may be wrapped
 * in backticks, and a leading `./` is dropped); the note is the lines below. Without the flag, no paths and
 * the whole text is the note. A refusal for no paths, more than MAX_COMMAND_PATHS, or a path that is empty,
 * absolute, has `..` or has a glob. Duplicates are dropped; coverage against allowed_paths is the caller's.
 */
export function parseCommandPaths(text: string): { paths: string[]; note: string } | { refuse: string } {
  const [first = "", ...rest] = text.trim().split(/\r?\n/);
  const m = PATHS_FLAG.exec(first.trim());
  if (!m) return { paths: [], note: text.trim() };
  const tokens = first.trim().slice(m[0].length).split(/\s+/).filter((t) => t !== "")
    .map((t) => t.replace(/^`([^`]*)`$/, "$1").replace(/^(\.\/)+/, ""));
  if (tokens.length === 0) return { refuse: "`+paths` needs at least one path after it on the same line, e.g. `+paths src/core/x.ts`" };
  if (tokens.length > MAX_COMMAND_PATHS) {
    return { refuse: `\`+paths\` takes at most ${MAX_COMMAND_PATHS} paths per command, not ${tokens.length}` };
  }
  for (const t of tokens) {
    const problem = commandPathProblem(t);
    if (problem) return { refuse: `\`+paths\` takes repo-relative paths only, and ${t === "" ? "one" : `\`${t}\``} is ${problem}` };
  }
  return { paths: [...new Set(tokens)], note: rest.join("\n").trim() };
}

/**
 * The exact `/retry +paths ...` reply that allows `paths`, or null when no such reply exists: none given, more
 * than MAX_COMMAND_PATHS, or one the parser would refuse or split (whitespace, a backtick).
 */
export function retryPathsReply(paths: readonly string[]): string | null {
  const unique = [...new Set(paths)];
  if (unique.length === 0 || unique.length > MAX_COMMAND_PATHS) return null;
  if (unique.some((p) => commandPathProblem(p) !== null || /[\s`]/.test(p) || p.startsWith("./"))) return null;
  return `/retry +paths ${unique.join(" ")}`;
}

/**
 * `/link <code>` (design 2026-11-01): the code, or "" when the line has none. Null for any other comment. The
 * code is a secret until used: callers never log or echo it.
 */
export function parseLink(body: string): string | null {
  const first = body.trim().split(/\r?\n/)[0]!.trim();
  const m = /^\/link(?=$|[\s.,:;!?])[.,:;!?]?\s*(\S*)/i.exec(first);
  return m ? m[1]! : null;
}
