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
  | "floor_tier"
  | "failed_run"
  | "reviewing"
  | "merge_pending"
  | "max_loops"
  | "merge_conflict"
  | "other_blocked"
  | "closed";

export const COMMAND_PHASES: readonly CommandPhase[] = [
  "triaging", "spec_pending", "budget_checkpoint", "max_revisions", "implementing", "floor_tier", "failed_run",
  "reviewing", "merge_pending", "max_loops", "merge_conflict", "other_blocked", "closed",
];

const OPEN_PHASES = COMMAND_PHASES.filter((p) => p !== "closed");

/** What the human can do depends on the phase and, for `/verdict`, on whether a PR exists yet. */
export interface CommandState {
  phase: CommandPhase;
  has_pr: boolean;
}

export type CommandName = "approve" | "reject" | "revise" | "retry" | "budget" | "verdict" | "help";

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
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "approve",
    usage: "/approve [notes]",
    description: "Approve the spec or the floor block. Notes on the same line or below go to the implementer and the reviewer",
    phases: ["spec_pending", "max_revisions", "floor_tier"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "reject",
    usage: "/reject <reason>",
    description: "Close the item without a merge, giving your reason",
    phases: ["spec_pending", "max_revisions", "floor_tier", "budget_checkpoint"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "revise",
    usage: "/revise <feedback>",
    description: "Get a new spec written with your feedback",
    phases: ["spec_pending"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "retry",
    usage: "/retry",
    description: "Run the failed run again",
    phases: ["failed_run"],
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
    description: "Record a verdict on the result; it does not change the state",
    phases: OPEN_PHASES,
    needs_pr: true,
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

/** The kind of run a human `/retry` would restart, or undefined if the item is not blocked by a failed run. */
export function failedRunKind(it: WorkItem): RunKind | undefined {
  const kind = it.blocked_reason?.match(/^run_failed:(triage|implement|review|update):/)?.[1] as RunKind | undefined;
  if (kind) return kind;
  if (it.blocked_reason !== "max_attempts" && it.blocked_reason !== "max_restart") return undefined;
  if (it.stage === "NEW") return "triage";
  if (it.stage === "RUNNING") return "implement";
  if (it.stage === "REVIEW") return "review";
  return undefined;
}

type ItemState = Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "pr_number">;

/** The phase of an item; the same checks, in the same order, as the controller's command handling. */
export function commandPhase(it: ItemState): CommandPhase {
  if (it.stage === "CLOSED") return "closed";
  if (it.blocked_reason === "budget_checkpoint") return "budget_checkpoint";
  if (it.blocked_reason === "floor_tier") return "floor_tier";
  if (it.blocked_on === "human" && failedRunKind(it as WorkItem)) return "failed_run";
  if (it.stage === "READY" && it.blocked_reason === "spec_pending") return "spec_pending";
  if (it.stage === "READY" && it.blocked_reason === "max_revisions") return "max_revisions";
  if (it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending") return "merge_pending";
  if (it.blocked_reason === "max_loops") return "max_loops";
  if (it.blocked_reason === "merge_conflict_pending") return "merge_conflict";
  if (it.blocked_on !== "none") return "other_blocked";
  if (it.stage === "NEW") return "triaging";
  if (it.stage === "REVIEW") return "reviewing";
  return "implementing";
}

export function commandState(it: ItemState): CommandState {
  return { phase: commandPhase(it), has_pr: it.pr_number !== null };
}

export function applies(c: CommandSpec, s: CommandState): boolean {
  return c.phases.includes(s.phase) && (!c.needs_pr || s.has_pr);
}

/** The commands that apply in `s`, in table order; `/help` always last. */
export function commandsFor(s: CommandState): CommandSpec[] {
  return COMMANDS.filter((c) => c.name !== "help" && applies(c, s)).concat(commandSpec("help"));
}

const line = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.description}.`;

/** The commands that apply now, then a note when none of them changes the state. Ends every waiting comment. */
export function commandFooter(s: CommandState): string {
  const cmds = commandsFor(s);
  const out = ["Commands you can reply with now:", ...cmds.map(line)];
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
    `Commands marked **(now)** apply to this item in its current state (\`${s.phase}\`).`,
    "",
    ...COMMANDS.map((c) => `- \`${c.usage}\`${applies(c, s) ? " **(now)**" : ""}: ${c.description}.`),
  ].join("\n");
}

const PHASE_LABELS: Record<CommandPhase, string> = {
  triaging: "triaging",
  spec_pending: "spec waiting for approval",
  budget_checkpoint: "paused at a budget checkpoint",
  max_revisions: "spec at the revision limit",
  implementing: "implementing",
  floor_tier: "blocked by the floor check",
  failed_run: "blocked by a failed run",
  reviewing: "in review",
  merge_pending: "waiting for a human merge",
  max_loops: "review loop limit reached",
  merge_conflict: "PR has a merge conflict",
  other_blocked: "blocked for another reason",
  closed: "closed",
};

function whenText(c: CommandSpec): string {
  const all = (ps: readonly CommandPhase[]) => ps.length === c.phases.length && ps.every((p) => c.phases.includes(p));
  const where = all(COMMAND_PHASES) ? "any time" : all(OPEN_PHASES) ? "any open item" : c.phases.map((p) => PHASE_LABELS[p]).join(", ");
  return c.needs_pr ? `${where}, once it has a PR` : where;
}

/** The command table in SET_UP.md, generated from COMMANDS; a test keeps the two equal. */
export function commandTableMarkdown(): string {
  return [
    "| Command | What it does | Applies when |",
    "|---|---|---|",
    ...COMMANDS.map((c) => `| \`${c.usage.replace(/\|/g, "\\|")}\` | ${c.description} | ${whenText(c)} |`),
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
  const same = first.trim().slice(m[0].length).replace(/^[.,:;!?]/, "").trim();
  return { kind: "command", name: name as CommandName, text: [same, ...rest].join("\n").trim() };
}
