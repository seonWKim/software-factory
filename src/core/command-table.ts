import type { CommandName } from "./commands.js";

/**
 * The one table of factory commands (issue #498; design 05-sources, "One command table"): every CLI command, with
 * its arguments, who may run it, what it prints, and the form it takes in a chat source (typed after a mention of
 * the bot in Slack). The CLI's usage and parsers, the SET_UP.md lists, the dashboard's command list and the chat
 * parser all read it, so adding an entry gives it to every front end; tests/command-table.test.ts fails when one
 * front end lacks an entry. The item commands' phases and replies stay in src/core/commands.ts.
 */

/** Who may run a command: anyone, anyone who may submit work, or the owner (the actions are the owner check's). */
export type CommandWho = "anyone" | "submit_work" | "approve_spec" | "approve_merge" | "owner";

/**
 * The CLI handler that runs it: local tasks, item commands, settings and the mode, (`queue`) the queue's own
 * handler (src/cli/handlers/run-next), schedules, or (`sentence`) the plain-words reader, which `factory` runs for
 * any first word no handler claims (src/main.ts).
 */
export type CommandGroup = "task" | "item" | "settings" | "queue" | "sentence" | "schedule";

/** The sentence form's name: `factory "<words>"`, a command in the owner's own words (design 04-gate-commands). */
export const SENTENCE_FORM = '"<words>"';

/**
 * What the chat form takes after its words: nothing, one ID, free text (notes, feedback, a reason), any words
 * (checked by the CLI's own parser), (`request`) the whole mention, in plain words, which is never parsed,
 * (`comment`) a comment command the chat parser leaves to the comment parser (`parseComment`), so a chat source
 * keeps it on its comment path: `/verdict` in a Slack thread (design 04-gate-commands, verdict command), or
 * (`no_chat`) no chat form at all: a command of the CLI and the dashboard only, with `chat` empty, which the chat
 * parser never reads and the chat lists leave out (`run-next`, design 05-coordination).
 */
export type ChatArgs = "none" | "id" | "text" | "any" | "request" | "comment" | "no_chat";

export interface TableCommand {
  /** The words after `factory`, e.g. `task show`. */
  name: string;
  /** The CLI's arguments after the name; "" for none. */
  args: string;
  who: CommandWho;
  group: CommandGroup;
  /** One line: what it does. */
  does: string;
  /** One line: what it prints. */
  prints: string;
  /**
   * As typed after a mention of the bot, e.g. `show <id>`, `/approve [notes]`. A leading `/` is required when shown,
   * except in an item's thread, where the Slack source adds it to a bare command word (issue #541); lists show the
   * form without it.
   */
  chat: string;
  chat_args: ChatArgs;
  /** Acts on one work item: in chat only in the item's thread (which names the item), on the dashboard a command on its page. */
  item: boolean;
  /**
   * A write to settings or the mode: refused from chat until chat commands carry an edge passport (#479).
   * Reads still work there.
   */
  edge: boolean;
  /**
   * Whether it can be undone (design 08-permissions, the permission gate): `ask_irreversible` runs an agent's
   * reversible write without asking and holds any other. Required; an entry that declares neither counts as irreversible.
   */
  reversible: boolean;
}

const ITEM_PRINTS = "the stored command's number; the controller applies it and answers in the item's thread";

const item = (name: CommandName, args: string, does: string): TableCommand => ({
  name, args: `<id> ${args}`, who: "approve_spec", group: "item", does, prints: ITEM_PRINTS, chat: `/${name} ${args}`, chat_args: "text", item: true, edge: false, reversible: false,
});

export const COMMAND_TABLE: readonly TableCommand[] = [
  {
    name: "task create", args: "--title <t> --body-file <f> [--depends-on <id>]", who: "submit_work", group: "task",
    does: "Create a work item from a title and a body; `--depends-on <id>` writes a `Depends on: <id>` line, so its implement run waits until that local item merges " +
      "(an ID that names no local item is refused); in chat, a mention with any other words, outside an item's thread, is the request",
    prints: "the new work item's ID", chat: "<request in plain words>", chat_args: "request", item: false, edge: false, reversible: false,
  },
  {
    name: "task add", args: "<words>", who: "submit_work", group: "task",
    does: "Add a plain task, never a work item or a triage run; quick-add words set its fields: `today`, `tomorrow` or `YYYY-MM-DD`, " +
      "`HH:MM`, `!1` to `!3`, `#label`, `+project`, `every day`, `every week` or `every month`, and the words left are its title",
    prints: "the task: ID, title, due, priority, list and recurrence", chat: "task add <words>", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "task done", args: "<task_id>", who: "submit_work", group: "task",
    does: "Complete a plain task; a recurring one gets its next occurrence once, however often it is completed",
    prints: "that it is done (or already was), and the next occurrence", chat: "task done <task_id>", chat_args: "id", item: false, edge: false, reversible: true,
  },
  {
    name: "task reopen", args: "<task_id>", who: "submit_work", group: "task",
    does: "Undo a plain task's completion; a recurring one's next occurrence is removed while it is open, and the undo is refused once that is done",
    prints: "that it is open again (or was not done), and the next occurrence it removed", chat: "task reopen <task_id>", chat_args: "id", item: false, edge: false, reversible: true,
  },
  {
    name: "task edit", args: "<task_id> <words>", who: "submit_work", group: "task",
    does: "Edit an open plain task with quick-add words: only the fields they name change, and words with no title keep the title",
    prints: "the edited task", chat: "task edit <task_id> <words>", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "task delete", args: "<task_id>", who: "submit_work", group: "task",
    does: "Delete a plain task for good; refused while it has open sub-tasks, and its done sub-tasks become plain tasks",
    prints: "that it is deleted, and the done sub-tasks it detached", chat: "task delete <task_id>", chat_args: "id", item: false, edge: false, reversible: false,
  },
  {
    name: "task sub", args: "<parent_id> <words>", who: "submit_work", group: "task",
    does: "Add a sub-task under a plain task from quick-add words, one level deep: a sub-task cannot have sub-tasks",
    prints: "the sub-task, with its parent's ID", chat: "task sub <parent_id> <words>", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "task build", args: "<task_id>", who: "submit_work", group: "task",
    does: "Send an open plain task to intake as one local work item, linked to the task; building it again makes no second item, " +
      "and a merge of that item completes the task",
    prints: "the work item's ID (or that the task was already built as it)", chat: "task build <task_id>", chat_args: "id", item: false, edge: false, reversible: false,
  },
  {
    name: "task list", args: "[--project <project_slug>]", who: "anyone", group: "task",
    does: "List local work items, then open plain tasks, or with `--project` one task project's",
    prints: "one line per local work item: ID, title, stage and blocked reason; then a Tasks section, one line per open task with its projects " +
      "after its list (`-`, or `+a,+b`; a sub-task with its parent's ID)", chat: "list", chat_args: "none", item: false, edge: false, reversible: false,
  },
  {
    name: "task project", args: "<task_id> [-<from>] +<slug>|-<slug>", who: "submit_work", group: "task",
    does: "Add, remove or move a task's project",
    prints: "that it was added, taken out or moved (or already was)", chat: "task project <task_id> [-<from>] +<slug>|-<slug>", chat_args: "any",
    item: false, edge: false, reversible: true,
  },
  {
    name: "project create", args: "<name>", who: "submit_work", group: "task",
    does: "Create a task project, a group of plain tasks",
    prints: "the project: +slug and name", chat: "project create <name>", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "project list", args: "[--archived]", who: "submit_work", group: "task", does: "List task projects, or the archived ones",
    prints: "one line per project: +slug and name", chat: "project list [--archived]", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "project rename", args: "<slug> <name>", who: "submit_work", group: "task", does: "Rename a task project",
    prints: "the renamed project", chat: "project rename <slug> <name>", chat_args: "any", item: false, edge: false, reversible: true,
  },
  {
    name: "project archive", args: "<slug>", who: "submit_work", group: "task",
    does: "Archive a task project; its tasks stay in it",
    prints: "that it is archived (or already was)", chat: "project archive <slug>", chat_args: "id", item: false, edge: false, reversible: true,
  },
  {
    name: "project restore", args: "<slug>", who: "submit_work", group: "task", does: "Restore an archived task project",
    prints: "that it is active again (or already was)", chat: "project restore <slug>", chat_args: "id", item: false, edge: false, reversible: true,
  },
  {
    name: "project delete", args: "<slug>", who: "submit_work", group: "task", does: "Delete a task project, not its tasks",
    prints: "that it is deleted, and the tasks it took out", chat: "project delete <slug>", chat_args: "id", item: false, edge: false, reversible: false,
  },
  {
    name: "task show", args: "<id>", who: "anyone", group: "task", does: "Show one work item",
    prints: "its state, spec, sub-tasks, runs and stored messages", chat: "show <id>", chat_args: "id", item: false, edge: false, reversible: false,
  },
  item("approve", "[notes]", "Store `/approve` for the item"),
  item("retry", "[text]", "Store `/retry` for the item"),
  item("revise", "<feedback>", "Store `/revise` for the item; on a New or in-triage item it adds context, queued for one re-triage after the current triage run"),
  item("reject", "<reason>", "Store `/reject` for the item"),
  item("resolve", "[notes]", "Store `/resolve` for the item"),
  {
    name: "task paths", args: "<id> +<path>...", who: "approve_spec", group: "task",
    does: "Store `/paths` for a running item: add those paths (at most 10, each with `+` before it) to its allowed paths, which never removes one",
    prints: ITEM_PRINTS, chat: "/paths +<path>...", chat_args: "text", item: true, edge: false, reversible: false,
  },
  {
    name: "task note", args: "<id> <text>", who: "approve_spec", group: "task",
    does: "Store `/note` for an open item: a note for its reviewer and implementer, such as the reason a done-when line is built differently, which changes no stage",
    prints: ITEM_PRINTS, chat: "/note <text>", chat_args: "text", item: true, edge: false, reversible: false,
  },
  item("hold", "<id>", "Store `/hold <id>` for the item: hold it until the local item `<id>` merges (when its implement run asked for a human or is queued, not running)"),
  { ...item("verdict", "<accept|changes|reject> [<severity> <reason>]", "Store `/verdict` for the item: a verdict on its result, which changes no state"), chat_args: "comment" },
  {
    name: "merge", args: "<id>", who: "approve_merge", group: "item",
    does: "Merge a local item's branch into the local base branch once its review passed (no push; in auto mode the controller may merge it itself)",
    prints: ITEM_PRINTS, chat: "merge", chat_args: "none", item: true, edge: false, reversible: false,
  },
  {
    name: "run-next", args: "<id>", who: "approve_spec", group: "queue",
    does: "Move the item's queued run to queue position 1, ahead of earlier Run next moves; it starts nothing a busy item, a dependency, " +
      "a coordination hold, paused claims or a rate limit keeps queued (the item page's Run next; not in chat)",
    prints: ITEM_PRINTS, chat: "", chat_args: "no_chat", item: true, edge: false, reversible: true,
  },
  {
    name: SENTENCE_FORM, args: "", who: "approve_spec", group: "sentence",
    does: "Read a command in your own words with the plain-words reader; in chat, a reply with no mention in an item's thread the factory owns. " +
      "Nothing changes: each proposed command is stored as pending until it is confirmed",
    prints: "each proposed command as its typed line, with the proposal ID to confirm", chat: "<command in your own words>", chat_args: "request",
    item: false, edge: false, reversible: false,
  },
  {
    name: "confirm", args: "<proposal-id>", who: "approve_spec", group: "item",
    does: "Confirm a stored proposal: the controller applies each of its pending commands once, through the typed command's path and check, as you",
    prints: "the stored command's number, or that nothing is pending; the controller answers a refusal in the item's thread", chat: "confirm <proposal-id>",
    chat_args: "id", item: false, edge: false, reversible: false,
  },
  {
    name: "settings list", args: "", who: "anyone", group: "settings", does: "List every settable key",
    prints: "each key's effective value and its source (override, file, default)", chat: "settings list", chat_args: "none", item: false, edge: false, reversible: false,
  },
  {
    name: "settings set", args: "<key> <value> [--project <owner/name>]", who: "anyone", group: "settings",
    does: "Store an override; `<value>` is JSON. `mode`, `auto_merge_max_tier` and a change that loosens a tighten-only key need approve_merge",
    prints: "the key's new and old value with their sources, and when it applies", chat: "settings set <key> <value> [--project <owner/name>]", chat_args: "any",
    item: false, edge: true, reversible: true,
  },
  {
    name: "settings reset", args: "<key> [--project <owner/name>]", who: "anyone", group: "settings",
    does: "Remove an override, so the file value (else the default) applies again; the same approve_merge rule as `settings set`",
    prints: "the key's new and old value with their sources, and when it applies", chat: "settings reset <key> [--project <owner/name>]", chat_args: "any",
    item: false, edge: true, reversible: true,
  },
  {
    name: "settings history", args: "[--limit <n>]", who: "anyone", group: "settings", does: "Show the settings audit",
    prints: "every set and reset, newest first (default 50)", chat: "settings history [--limit <n>]", chat_args: "any", item: false, edge: false, reversible: false,
  },
  {
    name: "mode", args: "auto|manual [--project <owner/name>]", who: "approve_merge", group: "settings", does: "The same as `settings set mode <auto|manual>`",
    prints: "the mode's new and old value", chat: "mode auto|manual [--project <owner/name>]", chat_args: "any", item: false, edge: true, reversible: true,
  },
  ...scheduleCommands(),
];

/** `factory schedule …` (design 08-schedules): list, add, edit, pause, resume, run, runs, delete, draft and improve, in that order; the writes are the owner's only. */
function scheduleCommands(): TableCommand[] {
  const optional = "[--body <text>] [--token-cap <n>] [--missed catch-up|skip]";
  const page = "[--url <url>] [--instruction <text>] [--run-cap <usd|none>] [--daily-cap <usd|none>]";
  const one = (name: string, args: string, chat: string, chat_args: ChatArgs, does: string, prints: string): TableCommand => ({
    name: `schedule ${name}`, args, who: "owner", group: "schedule", does, prints, chat: `schedule ${chat}`, chat_args, item: false, edge: false, reversible: name === "pause" || name === "resume",
  });
  return [
    one("list", "", "list", "none", "List the schedules", "one line per schedule, Check a page ones too: ID, title, next due time, `paused` or `on each merge`, running or idle, action kind, missed rule, token cap"),
    one(
      "add", `--id <id> --title <t> --cadence <interval|daily|weekly|cron|on-merge> [--spec <spec>] [--zone <IANA>] --action <build|agent|feedback|check-page> ${optional} [--run-now on|off] ${page}`, "add <flags>", "any",
      "Store a new schedule, first due at its cadence's next slot after now; refused for an ID already stored, a bad cadence, zone or action, " +
        "and an agent or feedback action without `--body` (its prompt; a build's item body); a daily schedule's token cap counts the runs of each UTC day, any other's all its runs. " +
        "A check-page action needs an http(s) `--url` and `--instruction` (or `--body`), and takes USD caps; only it takes `--cadence on-merge`, with no `--spec` (zone UTC)",
      "the stored schedule's line",
    ),
    one(
      "edit", `<id> [--title <t>] [--cadence <interval|daily|weekly|cron>] [--spec <spec>] [--zone <IANA>] [--action <build|agent|feedback>] ${optional} ${page}`, "edit <id> <flags>", "any",
      "Change only the flags given; a new cadence or zone sets an unpaused schedule's next due time to its first slot after now, " +
        "and a paused one stays paused; refused with no flag, or a bad cadence, zone, action, token cap or USD cap; a check-page schedule's cadence, zone or trigger does not change, " +
        "and no action changes to or from check-page",
      "the edited schedule's line",
    ),
    one("pause", "<id>", "pause <id>", "id", "Clear the schedule's next due time, so none of its slots fire (a check-page one is marked paused); refused when already paused", "the paused schedule's line"),
    one("resume", "<id>", "resume <id>", "id", "Set a paused schedule's next due time to its first slot after now; refused when not paused", "the resumed schedule's line"),
    one("run", "<id>", "run <id>", "id", "Set the schedule's next due time to now, so the next tick fires it once; refused when paused or on-merge, writing nothing", "the schedule's line"),
    one("runs", "<id>", "runs <id>", "id", "List the schedule's runs, oldest first", "one line per run: occurrence, outcome, recorded time, tokens, cost"),
    one(
      "delete", "<id>", "delete <id>", "id",
      "Remove the schedule and its suggestions in one transaction, so none of its slots fire again; a run in flight finishes, its past runs and their items stay; refused for an unknown ID",
      "the deleted schedule's line",
    ),
    // Draft and improve ask y/N on the terminal before they write (src/core/schedule-draft.ts), so they have no chat form.
    {
      ...one(
        "draft", "<words…> [--yes]", "", "no_chat",
        "Draft a schedule from your words with the configured model (plugins.llm), then ask y/N before adding it; `--yes`, the last word, adds it " +
          "without asking; refused with no model, no terminal and no `--yes`, a failed model call, or a cadence, zone or action the checks of `schedule add` refuse",
        "the proposed schedule, then the added schedule's line, or that nothing was stored",
      ),
      chat: "",
    },
    {
      ...one(
        "improve", "<id> [--yes]", "", "no_chat",
        "Have the configured model revise the schedule's text (a build's body, an agent's or feedback's prompt), then ask y/N before writing it; " +
          "`--yes`, the last word, writes it without asking; refused with no model, no terminal and no `--yes`, or a failed model call",
        "the old and the new text, then the edited schedule's line, or that nothing was stored",
      ),
      chat: "",
    },
  ];
}

/** As typed after `factory`. */
export function cliUsageOf(c: TableCommand): string {
  return c.args === "" ? c.name : `${c.name} ${c.args}`;
}

/** The first word of each command in `groups`, in table order, once each: the words `factory` hands to their handler. */
export function topWords(groups: readonly CommandGroup[]): string[] {
  return [...new Set(COMMAND_TABLE.filter((c) => groups.includes(c.group)).map((c) => c.name.split(" ")[0]!))];
}

/** The `/help` line naming the CLI commands (src/core/commands.ts). */
export function cliHelpLine(): string {
  return `From the command line: ${COMMAND_TABLE.map((c) => `\`factory ${cliUsageOf(c)}\``).join(", ")}.`;
}

const WHO: Record<CommandWho, string> = {
  anyone: "anyone",
  submit_work: "anyone who may submit work",
  approve_spec: "the owner",
  approve_merge: "the owner",
  owner: "the owner",
};

/** One line of the CLI list: usage, what it does, who may run it and what it prints. */
export function commandLine(c: TableCommand): string {
  return `${c.does}. Who: ${WHO[c.who]}. Prints: ${c.prints}`;
}

/**
 * The SET_UP.md chat list, one bullet per command with a chat form, each without a leading `/` (an item command is typed in its item's
 * thread, where the bare word works). tests/command-table.test.ts fails when SET_UP.md differs.
 */
export function chatCommandListMarkdown(): string {
  return COMMAND_TABLE.filter((c) => c.chat_args !== "no_chat").map((c) => {
    const where = c.edge ? "; refused in chat until #479, so use the CLI"
      : c.item ? ", in the item's thread"
      : c.group === "sentence" ? "; in an item's thread the factory owns, a reply with no mention" : "";
    return `- \`@bot ${c.chat.replace(/^\//, "")}\`: as \`factory ${cliUsageOf(c)}\`${where}. Who: ${WHO[c.who]}.`;
  }).join("\n");
}

/** A chat command parsed from the text after a mention: `help`, or a table entry with its words and text. */
export type ChatCommand =
  | { kind: "help" }
  | { kind: "command"; entry: TableCommand; args: string[]; text: string };

/** The literal words a chat form starts with (before its first placeholder, `+<path>` too), lowercase, without the `/`. */
function chatWords(c: TableCommand): string[] {
  const out: string[] = [];
  for (const w of c.chat.replace(/^\//, "").split(/\s+/)) {
    if (/^[<[]/.test(w) || w.includes("|") || w.includes("<")) break;
    out.push(w.toLowerCase());
  }
  return out;
}

const BY_WORDS = COMMAND_TABLE.filter((c) => !["request", "comment", "no_chat"].includes(c.chat_args)).sort((a, b) => chatWords(b).length - chatWords(a).length);

/**
 * The chat command in `text` (the words after a mention), or null when it is none: then it is a request, a comment
 * in plain words, or a `comment` form's command, which the comment parser reads. A form's words match whole and in any case; a form shown with `/` needs it, any other takes an
 * optional one. Its arguments must fit: `none` takes nothing more, `id` one word, `text` and `any` the rest. So
 * "list the open bugs" is a request, not `list`. `help` alone is help.
 */
export function parseChatCommand(text: string): ChatCommand | null {
  const [first = "", ...rest] = text.trim().split(/\r?\n/);
  const line = first.trim();
  const tokens = line.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  const slashed = tokens[0]!.startsWith("/");
  const lead = tokens.map((t, i) => (i === 0 ? t.slice(slashed ? 1 : 0) : t).replace(/[.,:;!?]$/, "").toLowerCase());
  const more = rest.join("\n").trim();
  if (lead[0] === "help" && tokens.length === 1 && more === "") return { kind: "help" };
  for (const entry of BY_WORDS) {
    const words = chatWords(entry);
    if (entry.chat.startsWith("/") && !slashed) continue;
    if (tokens.length < words.length || !words.every((w, i) => lead[i] === w)) continue;
    const args = tokens.slice(words.length);
    const after = line.split(/\s+/).slice(words.length).join(" ");
    const all = [after, more].filter((s) => s !== "").join("\n").trim();
    if (entry.chat_args === "none" && (args.length > 0 || more !== "")) return null;
    if (entry.chat_args === "id" && (args.length !== 1 || more !== "")) return null;
    return { kind: "command", entry, args, text: all };
  }
  return null;
}

/**
 * The CLI argv a chat command stands for, after its top word: the sub-command words, then for an item command
 * the item `id` (from the thread) and the text, else the words typed.
 */
export function chatCliArgv(c: Extract<ChatCommand, { kind: "command" }>, id: string | null): { word: string; args: string[] } {
  const [word, ...sub] = c.entry.name.split(" ");
  const rest = c.entry.item ? [...(id !== null ? [id] : []), ...(c.text !== "" ? [c.text] : [])] : c.args;
  return { word: word!, args: [...sub, ...rest] };
}
