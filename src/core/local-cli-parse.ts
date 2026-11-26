import type { WorkItemId } from "./types.js";
import { MERGE_COMMAND } from "./local-merge.js";
import { COMMAND_TABLE, cliUsageOf, commandLine } from "./command-table.js";
import { VERDICT_USAGE, parseVerdict } from "./verdict.js";
import { isProposalId } from "./interpret.js";
import { parseQuickAdd, parseQuickEdit } from "./quick-add.js"; import { projectSlug } from "./projects.js";
import type { TaskEdit, TaskFields } from "./tasks.js";
import { CREATE_HELP, LOCAL_ID } from "./task-build.js";
import { type ScheduleWords, parseScheduleWords } from "./schedule-draft.js";
import { CLI_TOP_WORDS, CONFIRM_WORD, HELP_WORD } from "./local-cli-identity.js";

// The CLI's argument parser and usage text (split from src/core/local-cli.ts, issue #834): nothing is read or written.

const ITEM_COMMANDS = ["approve", "retry", "revise", "reject", "resolve", "verdict", "hold"] as const;
/** `merge` is the local merge (src/core/local-merge.ts); `paths` is `task paths`, `note` is `task note`; the others are the comment commands of the same name. */
export type ItemCommand = (typeof ITEM_COMMANDS)[number] | typeof MERGE_COMMAND | "paths" | "note";

export type CliAction =
  /** `project`: the `--project` slug, left out for the work item only; `depends_on`: the `--depends-on` id (design 05-dependencies). */
  | { action: "create"; title: string; bodyFile: string; project?: string; depends_on?: string }
  | { action: "add"; task: TaskFields }
  | { action: "done"; id: string }
  | { action: "reopen"; id: string }
  | { action: "edit"; id: string; edit: TaskEdit }
  | { action: "delete"; id: string }
  | { action: "sub"; parent: string; task: TaskFields }
  | { action: "build"; id: string }
  /** `project`: the `--project` filter's name as typed; left out, every open task. */
  | { action: "list"; project?: string }
  | { action: "task_project"; id: string; slug: string; add: boolean }
  | { action: "task_move"; id: string; from: string; to: string }
  | { action: "project"; verb: "create"; name: string }
  | { action: "project"; verb: "list"; archived: boolean }
  | { action: "project"; verb: "rename"; slug: string; name: string }
  | { action: "project"; verb: "archive" | "restore" | "delete"; slug: string }
  | { action: "show"; id: WorkItemId }
  | { action: "command"; command: ItemCommand; id: WorkItemId; text: string }
  | { action: "help"; id: WorkItemId | null }
  | { action: "confirm"; proposal: string }
  | { action: "schedule"; command: ScheduleWords };

/** This module's commands, from the command table (src/core/command-table.ts). */
const LOCAL_COMMANDS = COMMAND_TABLE.filter((c) => (CLI_TOP_WORDS as readonly string[]).includes(c.name.split(" ")[0]!));

export function cliUsage(): string {
  return ["usage: npm run factory -- <command>", ...LOCAL_COMMANDS.map((c) => `  ${cliUsageOf(c)}`)].join("\n");
}

/** The usage lines of `factory --help`: each command with what it does. */
export function cliUsageLines(): string {
  const help = `  ${`${HELP_WORD} [<id>]`.padEnd(40)} List every command, as \`/help\` does; with an item, the ones that apply to it now marked`;
  return [...LOCAL_COMMANDS.map((c) => `  ${cliUsageOf(c).padEnd(40)} ${c.does}`), help].join("\n");
}

/** The SET_UP.md list, one bullet per command of the table. tests/local-cli.test.ts fails when SET_UP.md differs. */
export function cliCommandListMarkdown(): string {
  return COMMAND_TABLE.map((c) => `- \`factory ${cliUsageOf(c)}\`: ${commandLine(c)}.`).join("\n");
}

/** The action, or an error line for anything incomplete or unknown (nothing is read or written). */
export function parseLocalCliArgs(word: string, args: readonly string[]): CliAction | { error: string } {
  const bad = (why: string) => ({ error: `${why}\n${cliUsage()}` });
  if (word === "task") {
    const [sub, ...rest] = args;
    if (sub === "list") {
      if (rest.length === 0) return { action: "list" };
      return rest.length === 2 && rest[0] === "--project" && rest[1] ? { action: "list", project: rest[1] } : bad("task list takes only --project <project_slug>");
    }
    if (sub === "project") {
      const [id, ...links] = rest;
      const slugOf = (sign: "+" | "-") => {
        const w = links.filter((l) => l.startsWith(sign));
        return w.length === 1 ? projectSlug(w[0]!.slice(1)) : null;
      };
      const [to, from] = [slugOf("+"), slugOf("-")];
      if (id && links.length === 2 && from !== null && to !== null && from !== to) return { action: "task_move", id, from, to };
      const slug = links.length === 1 ? to ?? from : null;
      if (!id || slug === null) return bad("task project needs a task ID and +<slug> to add it to a project, -<slug> to take it out, or -<from> +<to> to move it");
      return { action: "task_project", id, slug, add: links[0]!.startsWith("+") };
    }
    if (sub === "add") {
      const parsed = parseQuickAdd(rest.join(" "));
      return parsed.ok ? { action: "add", task: parsed.task } : bad(`task add: ${parsed.reason}`);
    }
    if (sub === "edit") {
      const [id, ...words] = rest;
      if (!id || words.length === 0) return bad("task edit needs a task ID and quick-add words");
      const parsed = parseQuickEdit(words.join(" "));
      return parsed.ok ? { action: "edit", id, edit: parsed.edit } : bad(`task edit: ${parsed.reason}`);
    }
    if (sub === "sub") {
      const [parent, ...words] = rest;
      if (!parent) return bad("task sub needs a parent task ID and quick-add words");
      const parsed = parseQuickAdd(words.join(" "));
      return parsed.ok ? { action: "sub", parent, task: parsed.task } : bad(`task sub: ${parsed.reason}`);
    }
    if (sub === "paths") return rest.length > 1 ? { action: "command", command: "paths", id: rest[0] as WorkItemId, text: rest.slice(1).join(" ") } : bad("task paths needs a work item ID and at least one +<path>"); // stored as `/paths`
    if (sub === "note") return rest.length > 1 ? { action: "command", command: "note", id: rest[0] as WorkItemId, text: rest.slice(1).join(" ") } : bad("task note needs a work item ID and the note's text"); // stored as `/note`
    if (sub === "delete") return rest.length === 1 && rest[0] ? { action: "delete", id: rest[0] } : bad("task delete needs one task ID");
    if (sub === "done") return rest.length === 1 && rest[0] ? { action: "done", id: rest[0] } : bad("task done needs one task ID");
    if (sub === "reopen") return rest.length === 1 && rest[0] ? { action: "reopen", id: rest[0] } : bad("task reopen needs one task ID");
    if (sub === "build") return rest.length === 1 && rest[0] ? { action: "build", id: rest[0] } : bad("task build needs one task ID");
    if (sub === "show") return rest.length === 1 && rest[0] ? { action: "show", id: rest[0] as WorkItemId } : bad("task show needs one work item ID");
    if (sub === "create") {
      if (rest.includes("--help")) return bad(`task create: ${CREATE_HELP}`);
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 2) {
        const k = rest[i]!;
        const v = rest[i + 1];
        if (!["--title", "--body-file", "--project", "--depends-on"].includes(k) || v === undefined || k in flags) return bad(`task create: unexpected ${JSON.stringify(k)}`);
        flags[k] = v;
      }
      const title = flags["--title"]?.trim();
      const bodyFile = flags["--body-file"];
      if (!title || !bodyFile) return bad("task create needs --title <t> and --body-file <f>");
      // A bare short ID (the dashboard's 8 hex characters, or more) names a work item, as `wi_` + it.
      const given = flags["--depends-on"]?.trim();
      const dependsOn = given !== undefined && /^[0-9a-f]{8,32}$/.test(given) ? `wi_${given}` : given;
      if (dependsOn !== undefined && !LOCAL_ID.test(dependsOn)) return bad("task create: --depends-on needs a work item (wi_… or its short ID) or task (tk_…) ID");
      const project = flags["--project"] === undefined ? undefined : projectSlug(flags["--project"].replace(/^\+/, ""));
      if (project === null) return bad("task create: --project needs a project slug, e.g. home-repairs");
      return { action: "create", title, bodyFile, ...(project !== undefined ? { project } : {}), ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}) };
    }
    return bad(`unknown task command ${JSON.stringify(sub ?? "")}`);
  }
  if (word === "project") return parseProjectArgs(args, bad);
  if (word === "schedule") return ((c) => (typeof c === "string" ? bad(c) : { action: "schedule" as const, command: c }))(parseScheduleWords(args));
  if ((ITEM_COMMANDS as readonly string[]).includes(word)) {
    const [id, ...rest] = args;
    if (!id) return bad(`${word} needs a work item ID`);
    const text = rest.join(" ").trim();
    if (word === "hold" && (rest.length !== 1 || !LOCAL_ID.test(rest[0]!))) return bad("hold needs a work item ID and the ID of the local item to wait for (wi_… or tk_…)");
    if (word === "verdict") {
      const v = parseVerdict(text);
      if (!v.ok) return bad(v.refuse.includes(VERDICT_USAGE) ? v.refuse : `${v.refuse}; the expected format is ${VERDICT_USAGE}`);
    }
    return { action: "command", command: word as ItemCommand, id: id as WorkItemId, text };
  }
  if (word === HELP_WORD) {
    if (args.length > 1) return bad("help takes at most one work item ID");
    return { action: "help", id: (args[0] as WorkItemId | undefined) ?? null };
  }
  if (word === CONFIRM_WORD) return args.length === 1 && isProposalId(args[0]!) ? { action: "confirm", proposal: args[0]! } : bad("confirm needs one proposal ID, as `factory \"<words>\"` printed it");
  if (word === MERGE_COMMAND) {
    const [id, ...rest] = args;
    if (!id || rest.length > 0) return bad("merge needs one work item ID");
    return { action: "command", command: MERGE_COMMAND, id: id as WorkItemId, text: "" };
  }
  return bad(`unknown command ${JSON.stringify(word)}`);
}

/** `factory project <verb> …`: a slug as typed is read through projectSlug, so `Home Repairs` names `home-repairs`. */
function parseProjectArgs(args: readonly string[], bad: (why: string) => { error: string }): CliAction | { error: string } {
  const [verb, ...rest] = args;
  const slug = (w: string | undefined) => (w === undefined ? null : projectSlug(w.replace(/^\+/, "")));
  if (verb === "create") return rest.length > 0 ? { action: "project", verb, name: rest.join(" ") } : bad("project create needs a name");
  if (verb === "list") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "--archived")) return { action: "project", verb, archived: rest.length === 1 };
    return bad("project list takes only --archived");
  }
  if (verb === "rename") {
    const [from, ...name] = rest;
    const s = slug(from);
    return s !== null && name.length > 0 ? { action: "project", verb, slug: s, name: name.join(" ") } : bad("project rename needs a project slug and the new name");
  }
  if (verb === "archive" || verb === "restore" || verb === "delete") {
    const s = slug(rest[0]);
    return rest.length === 1 && s !== null ? { action: "project", verb, slug: s } : bad(`project ${verb} needs one project slug`);
  }
  return bad(`unknown project command ${JSON.stringify(verb ?? "")}`);
}
