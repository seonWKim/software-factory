import { COMMAND_TABLE, type CommandWho, cliHelpLine } from "./command-table.js";
import { LOCAL_SOURCE } from "./local-merge.js";
import { type TriageOutput, parseTriage } from "./outputs.js";
import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE, blockingRunKind } from "./policy.js";
import { RECURRING_FAILURE, type Run, type RunKind, type WorkItem } from "./types.js";

/**
 * The human commands on a work item (design §4): one table of names, usage, descriptions and the states
 * each applies in, plus a pure parser for comment bodies. Footers, `/help` replies (issue comments, Slack, `factory help`),
 * unknown-command replies, refusals and the SET_UP.md command table are all built here, so they cannot drift from
 * each other.
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
  | "other_blocked"
  /** CLOSED with its PR merged: only a `/verdict` still applies (design §4). */
  | "merged"
  | "closed";

export const COMMAND_PHASES: readonly CommandPhase[] = [
  "triaging", "spec_pending", "budget_checkpoint", "max_revisions", "implementing", "dependency_hold", "dependency_closed", "floor_tier",
  "rule_of_two", "too_large",
  "failed_implement", "failed_review", "failed_run", "agent_needs_human", "repeated_failure", "recurring_failure", "reviewing", "merge_pending", "max_loops", "merge_conflict", "other_blocked", "merged", "closed",
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
  /** At `agent_needs_human`, it applies only when the run that asked was one of these kinds. Absent: any kind. */
  asked_by?: readonly RunKind[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "approve",
    usage: "/approve [notes]",
    description:
      "Approve the spec, the floor block or a run held for a person by the Rule of Two, or start an implement run held by coordination cost now (not one waiting for a dependency). Notes on the same line or below go to the implementer and the reviewer. " +
      "`/approve +paths <path>...` (at most 10, notes on the lines below) on the spec or the floor block also adds those paths to the allowed paths",
    // Also accepted on an implement run held by coordination cost (design §5, 2026-11-03): that hold is not in the
    // item's fields, so it is no phase here; the hold comment names the command. Never on a dependency hold.
    phases: ["spec_pending", "max_revisions", "floor_tier", "rule_of_two"],
    needs_pr: false,
    changes_state: true,
  },
  {
    name: "reject",
    usage: "/reject <reason>",
    description: "Close the item without a merge, giving your reason",
    phases: [
      "spec_pending", "max_revisions", "floor_tier", "rule_of_two", "budget_checkpoint", "too_large", "failed_implement", "agent_needs_human", "repeated_failure",
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
      "At the review loop limit, it starts an implement run with the loop count reset; `+paths` applies there too. " +
      "On an item held for a recurring failure, it lifts the hold so the item's queued runs start",
    // At a dependency closed unmerged it reads the dependencies again and releases the item if they merged (design §5).
    phases: ["failed_run", "failed_review", "too_large", "failed_implement", "agent_needs_human", "repeated_failure", "dependency_closed", "max_loops", "recurring_failure"],
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

type ItemState = Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "change_ref"> & Partial<Pick<WorkItem, "merge_sha" | "source">>;

/** The phase of an item; the same checks, in the same order, as the controller's command handling. */
export function commandPhase(it: ItemState): CommandPhase {
  if (it.stage === "CLOSED") return it.merge_sha ? "merged" : "closed";
  if (it.blocked_reason === "budget_checkpoint") return "budget_checkpoint";
  if (it.blocked_reason === "floor_tier") return "floor_tier";
  if (it.blocked_reason === "rule_of_two") return "rule_of_two";
  if (it.blocked_on === "human") {
    if (it.blocked_reason === AGENT_NEEDS_HUMAN) return "agent_needs_human";
    if (it.blocked_reason === REPEATED_FAILURE) return "repeated_failure";
    if (it.blocked_reason === RECURRING_FAILURE) return "recurring_failure";
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
  return {
    phase, has_pr: it.change_ref !== null, ...(it.source?.type === LOCAL_SOURCE ? { local: true as const } : {}),
    ...(phase === "agent_needs_human" && askedBy ? { asked_by: askedBy } : {}),
  };
}

/** The command state of `it` read with its runs (the kind of run that asked at agent_needs_human), as the controller reads it. */
export function itemCommandState(it: ItemState, runs: readonly Run[]): CommandState {
  return commandState(it, it.blocked_reason === AGENT_NEEDS_HUMAN ? blockingRunKind(it.blocked_reason, runs) : undefined);
}

export function applies(c: CommandSpec, s: CommandState): boolean {
  if (!c.phases.includes(s.phase) || (c.needs_pr && !s.has_pr && !s.local)) return false;
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

/** One command as every list shows it: the issue footer and `/help`, Slack's help in an item's thread. */
const line = (c: CommandSpec): string => `- \`${c.usage}\`: ${c.description}.`;

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
  out.push("Commands you can reply with now:", ...cmds.map(line));
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
  rule_of_two: "waiting for a person to approve its run (Rule of Two)",
  too_large: "blocked: the change was too large",
  failed_implement: "blocked by a failed implement run",
  failed_review: "blocked by a failed review run",
  failed_run: "blocked by a failed run",
  agent_needs_human: "blocked: the agent asked for a human",
  repeated_failure: "blocked: a run failed the same way twice",
  recurring_failure: "held: its run failed like a known recurring failure",
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
  return (c.needs_pr ? `${where}, once it has a PR (a local item needs none)` : where) + onPr;
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

/** The bot as chat help names it (the Slack app's name, scripts/slack-app.sh). */
export const CHAT_BOT = "@software-factory";

/**
 * The chat `help` reply: only the commands the sender may run in that place. `may` says whether the sender's role
 * allows an action; `state` is the item's when asked in its thread, else null. Outside an item's thread: the
 * reads, the request that starts work, and `/link` (there a bare `link` would be a request). In an item's thread: the
 * reads, `merge` when it applies, and the item's commands that apply now, each line the issue footer's text for that
 * state (issue #528) shown without its `/` (chatForm, issue #541), as typed after the mention there. Writes refused in
 * chat (`edge`) are never listed.
 */
export function chatHelpReply(may: (w: CommandWho) => boolean, state: CommandState | null): string {
  const lines: string[] = [];
  for (const c of COMMAND_TABLE) {
    if (c.edge || !may(c.who)) continue;
    if (c.chat_args === "request" && state !== null) continue;
    if (c.item && (c.name !== "merge" || state?.phase !== "merge_pending")) continue;
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

/**
 * The reason a user's role does not allow a command (`reason`: the auth decision's, e.g. `no_role`), as the controller
 * says it for a local, app or chat command judged by the local auth plugin. The dashboard shows it for the commands it
 * leaves out for the viewer.
 */
export function roleRefusal(user: string, reason: string): string {
  return `${user} has no role that allows it (\`${reason}\`); the local owner can grant one with \`factory users add ${user} --role approver\``;
}

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
  const s = commandState(it);
  if (applies(commandSpec("approve"), s)) return null;
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
