import type { UserId, WorkItem, WorkItemId } from "./types.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, LocalRole } from "../interfaces/factory-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { MERGE_COMMAND } from "./local-merge.js";
import { COMMAND_TABLE, SENTENCE_FORM, cliUsageOf, commandLine, topWords } from "./command-table.js";
import { approveRefusal, helpReply, itemCommandState, refusalText } from "./commands.js";
import { VERDICT_USAGE, parseVerdict, verdictRefusal } from "./verdict.js";
import { CONFIRM_COMMAND, INTERPRET_MAX_CHARS, INTERPRET_MAX_ITEMS, interpret, interpretReply, interpretTexts, isProposalId, openItems, typed } from "./interpret.js";
import { parseQuickAdd } from "./quick-add.js";
import { type TaskFields, taskLine } from "./tasks.js";

/**
 * The writer side of local intake (issue #200; design 05-sources.md, "CLI intake"). `factory task create`
 * creates a local work item with its triage run queued; `task add` stores a plain task from quick-add words and `task
 * done` completes one (design 02-tasks: no work item, no triage); `task list` and `task show` read the store; `approve`,
 * `retry`, `revise`, `reject`, `resolve` and `verdict` append one row to the CLI command log (`command_inbox`) and change no item
 * state, for an item of any source; `approve` first runs the controller's phase check (`approveRefusal`) and refuses
 * with its text before any write (issue #528), and `verdict` its parser and closed-item check (`verdictRefusal`,
 * issue #523). `confirm <proposal-id>` appends one `proposal_confirm` row for a stored proposal with a pending command
 * (design 04-gate-commands, the CLI sentence form). `help [<id>]` prints the `/help` reply. The controller reads that log and applies each command with the same
 * authorize check and the same replies as the source comment, through the auth plugin for local commands (`local`
 * by default, issue #318); a command on a sync source's item is also mirrored to it, best effort, once the source
 * answers (design 05-sources, CLI intake); a verdict is not mirrored. Every command acts as the CLI identity (`cliIdentity`). The first identity to run a
 * writing command becomes the local owner; `users` lets the owner give others roles. No sync source call.
 */

/** Where the CLI identity came from, for `users list`. */
export type CliIdentitySource = "cli_user" | "git user.email" | "OS user" | "anonymous" | "linked chat account";

export interface CliIdentity {
  /** The factory user ID every CLI command acts as: `cli_user`, or `local:<value>`. */
  user: UserId;
  from: CliIdentitySource;
}

/** What the environment says about the operator; each null when unavailable. Read by main.ts, never here. */
export interface CliEnvironment {
  gitEmail: string | null;
  osUser: string | null;
}

/** The identity used when nothing in the environment names the operator. */
export const ANONYMOUS = "anonymous";

/**
 * The CLI identity (issue #318): `cli_user` from factory.config.json when set; else `local:<git user.email>`;
 * else `local:<OS user name>`; else `local:anonymous`. Keys only (an email or a login name), never a display
 * name such as git's `user.name`. A value with whitespace is skipped.
 */
export function cliIdentity(cliUser: UserId | null, env: CliEnvironment): CliIdentity {
  if (cliUser !== null) return { user: cliUser, from: "cli_user" };
  const ok = (v: string | null): v is string => v !== null && /^\S+$/.test(v.trim());
  if (ok(env.gitEmail)) return { user: `local:${env.gitEmail.trim().toLowerCase()}` as UserId, from: "git user.email" };
  if (ok(env.osUser)) return { user: `local:${env.osUser.trim()}` as UserId, from: "OS user" };
  return { user: `local:${ANONYMOUS}` as UserId, from: "anonymous" };
}

/** The identity a CLI command's actor has at intake: provider `local`, subject the actor after `local:`. */
export function localIdentity(actor: string): ExternalIdentity {
  return { provider: "local", subject: actor.startsWith("local:") ? actor.slice("local:".length) : actor };
}

const ANONYMOUS_USER = `local:${ANONYMOUS}` as UserId;
const CLI_KEY_PREFIX = "cli:";

/** Whether a command inbox key (or the comment id of its event) is a CLI command's: `cli:<random id>`. */
export function isCliCommandKey(key: string): boolean {
  return key.startsWith(CLI_KEY_PREFIX);
}
const USER_ID = /^[a-z]+:\S+$/;

/** The top-level words `factory` hands to this module: the table's task, item (with `confirm`) and users commands. */
export const CLI_TOP_WORDS = topWords(["task", "item", "users"]);

/** `factory help [<id>]`: the `/help` reply, which lists every command, so it is no entry of the command table. */
export const HELP_WORD = "help";

/** `factory confirm <proposal-id>`: confirms every pending command of a stored proposal. */
export const CONFIRM_WORD = "confirm";

/**
 * The dashboard's app commands beside the item commands (design 09-dashboard-app): the command box's sentence, read by
 * the controller's plain-words reader, and a stored proposal's Cancel. Its Confirm all is `proposal_confirm`, the
 * confirm row's own name (CONFIRM_COMMAND), as `factory confirm` stores it.
 */
export const SENTENCE_APP_COMMAND = "sentence";
export const CANCEL_APP_COMMAND = "proposal_cancel";

const ITEM_COMMANDS = ["approve", "retry", "revise", "reject", "resolve", "verdict"] as const;

/** `merge` is the local merge (src/core/local-merge.ts); the others are the comment commands of the same name. */
export type ItemCommand = (typeof ITEM_COMMANDS)[number] | typeof MERGE_COMMAND;

export type CliAction =
  | { action: "create"; title: string; bodyFile: string }
  | { action: "add"; task: TaskFields }
  | { action: "done"; id: string }
  | { action: "list" }
  | { action: "show"; id: WorkItemId }
  | { action: "command"; command: ItemCommand; id: WorkItemId; text: string }
  | { action: "help"; id: WorkItemId | null }
  | { action: "confirm"; proposal: string }
  | { action: "users_list" }
  | { action: "users_add"; user: UserId; role: Exclude<LocalRole, "owner"> }
  | { action: "users_remove"; user: UserId };

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
    if (sub === "list") return rest.length === 0 ? { action: "list" } : bad("task list takes no arguments");
    if (sub === "add") {
      const parsed = parseQuickAdd(rest.join(" "));
      return parsed.ok ? { action: "add", task: parsed.task } : bad(`task add: ${parsed.reason}`);
    }
    if (sub === "done") return rest.length === 1 && rest[0] ? { action: "done", id: rest[0] } : bad("task done needs one task ID");
    if (sub === "show") return rest.length === 1 && rest[0] ? { action: "show", id: rest[0] as WorkItemId } : bad("task show needs one work item ID");
    if (sub === "create") {
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 2) {
        const k = rest[i]!;
        const v = rest[i + 1];
        if ((k !== "--title" && k !== "--body-file") || v === undefined || k in flags) return bad(`task create: unexpected ${JSON.stringify(k)}`);
        flags[k] = v;
      }
      const title = flags["--title"]?.trim();
      const bodyFile = flags["--body-file"];
      if (!title || !bodyFile) return bad("task create needs --title <t> and --body-file <f>");
      return { action: "create", title, bodyFile };
    }
    return bad(`unknown task command ${JSON.stringify(sub ?? "")}`);
  }
  if ((ITEM_COMMANDS as readonly string[]).includes(word)) {
    const [id, ...rest] = args;
    if (!id) return bad(`${word} needs a work item ID`);
    const text = rest.join(" ").trim();
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
  if (word === CONFIRM_WORD) {
    return args.length === 1 && isProposalId(args[0]!) ? { action: "confirm", proposal: args[0]! } : bad("confirm needs one proposal ID, as `factory \"<words>\"` printed it");
  }
  if (word === MERGE_COMMAND) {
    const [id, ...rest] = args;
    if (!id || rest.length > 0) return bad("merge needs one work item ID");
    return { action: "command", command: MERGE_COMMAND, id: id as WorkItemId, text: "" };
  }
  if (word === "users") {
    const [sub, user, ...rest] = args;
    if (sub === "list") return user === undefined ? { action: "users_list" } : bad("users list takes no arguments");
    if (sub !== "add" && sub !== "remove") return bad(`unknown users command ${JSON.stringify(sub ?? "")}`);
    if (!user || !USER_ID.test(user)) return bad(`users ${sub} needs a factory user ID such as local:dev@example.com`);
    if (sub === "remove") return rest.length === 0 ? { action: "users_remove", user: user as UserId } : bad("users remove takes one user ID");
    const [flag, role, ...extra] = rest;
    if (flag !== "--role" || (role !== "approver" && role !== "requester") || extra.length > 0) {
      return bad("users add needs --role approver or --role requester");
    }
    return { action: "users_add", user: user as UserId, role };
  }
  return bad(`unknown command ${JSON.stringify(word)}`);
}

export interface LocalCliDeps {
  store: Pick<
    FactoryStore,
    "createWorkItem" | "getWorkItem" | "listWorkItems" | "listPhases" | "listRuns" | "listItemMessages" | "appendCliCommand"
    | "claimLocalOwner" | "listLocalUsers" | "setLocalUserRole" | "removeLocalUser" | "addTask" | "listTasks" | "completeTask" | "listCommandProposals"
  >;
  /** Who every command acts as (`cliIdentity`). */
  identity: CliIdentity;
  /** The configured repo's project key from the store, or null when none is stored yet. Only `create` asks. */
  project: () => Promise<string | null>;
  /** Reads a body file. */
  read: (path: string) => Promise<string>;
  /** A new random ID: a local item's source ID, a task's ID, a command's idempotency key. */
  newId: () => string;
  /** Display names by user ID (Identity's identity_profiles), looked up only to show; absent: IDs only. */
  displayNames?: (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /** The CLI identity's edge passport (Identity, RFC 0015 §8), stored on each command row. Absent: none. */
  passport?: () => Promise<string>;
  /**
   * The source type the command was typed in, when not the CLI (a chat command, design 05-sources): an item of that
   * source already shows it in its thread, so its row is not mirrored there. Absent: the CLI.
   */
  origin?: string;
}

export interface CliResult {
  code: number;
  lines: string[];
}

/** The most items, and the most open tasks, `task list` reads. */
export const TASK_LIST_LIMIT = 200;

export async function runLocalCli(d: LocalCliDeps, a: CliAction): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  const user = d.identity.user;
  // The first identity to write becomes the local owner (issue #318); anonymous never does.
  const claim = async () => (user === ANONYMOUS_USER ? null : d.store.claimLocalOwner(user));
  switch (a.action) {
    case "create": {
      const project = await d.project();
      if (project === null) {
        return fail("no project is stored yet: start the factory once (`npm run factory -- dev`) so it records the configured repo");
      }
      await claim();
      const body = (await d.read(a.bodyFile)).trim();
      const sid = `local-${d.newId()}`;
      const source = { type: "local" as const, id: sid, link: `local:${sid}` };
      const { item } = await d.store.createWorkItem(
        { source, title: a.title, requester_id: user, project, problem: `${a.title}\n\n${body}`.trim(), resources: [source.link] },
        { kind: "user", id: user },
        { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
      );
      return { code: 0, lines: [item.id] };
    }
    case "add": {
      await claim();
      const task = await d.store.addTask({ ...a.task, id: `tk_${d.newId()}`, created_by: user });
      return { code: 0, lines: [taskLine(task)] };
    }
    case "done": {
      const r = await d.store.completeTask(a.id);
      if (!r.ok) return fail(`no task ${a.id}`);
      const done = r.completed ? `done ${a.id}` : `${a.id} was already done`;
      return { code: 0, lines: [done, ...(r.next ? [`next: ${taskLine(r.next)}`] : [])] };
    }
    case "list": {
      const items = (await d.store.listWorkItems(TASK_LIST_LIMIT)).filter((i) => i.source.type === "local");
      const tasks = await d.store.listTasks(TASK_LIST_LIMIT);
      const lines = items.length === 0 ? ["no local work items"] : items.map((i) => [i.id, i.title ?? "", i.stage, i.blocked_reason ?? "-"].join("\t"));
      // Plain tasks in their own section after the work items (design 02-tasks), only when there are any.
      return { code: 0, lines: tasks.length === 0 ? lines : [...lines, "", "Tasks", ...tasks.map(taskLine)] };
    }
    case "show": {
      const item = await d.store.getWorkItem(a.id);
      if (!item) return fail(`no work item ${a.id}`);
      return { code: 0, lines: await showLines(d, item) };
    }
    case "command": {
      const item = await d.store.getWorkItem(a.id);
      if (!item) return fail(`no work item ${a.id}`);
      const name = a.command === MERGE_COMMAND ? "factory merge" : `/${a.command}`;
      if (a.command === MERGE_COMMAND && item.source.type !== "local") return fail(`${a.id} is not a local work item: merge its change on the forge instead`);
      // The controller's phase check, before any write: the same refusal it would post (issues #528, #523).
      const refused = a.command === "approve" ? approveRefusal(item) : a.command === "verdict" ? verdictRefusal(item) : null;
      if (refused !== null) return fail(refusalText(name, refused));
      await claim();
      const args: Record<string, unknown> = { item: item.id, ...(a.text !== "" ? { text: a.text } : {}) };
      // An item of a sync source gets the command mirrored on its issue later; a local item has no other surface, and
      // a command typed in the item's own thread is already there. A verdict changes no state, so it is not mirrored.
      const mirror = a.command !== "verdict" && item.source.type !== "local" && item.source.type !== d.origin;
      const passport_id = await d.passport?.();
      const { command } = await d.store.appendCliCommand({
        key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command: a.command, args, ...(mirror ? { mirror } : {}), ...(passport_id ? { passport_id } : {}),
      });
      return {
        code: 0,
        lines: [`stored \`${name}\` for ${item.id} as ${user} (command ${command.seq}); the controller applies it on its next poll, see \`factory task show ${item.id}\``],
      };
    }
    case "confirm": {
      const rows = await d.store.listCommandProposals(a.proposal);
      if (rows.length === 0) return fail(`no proposal ${a.proposal}`);
      const pending = rows.filter((r) => r.status === "pending");
      if (pending.length === 0) {
        return { code: 0, lines: [`nothing was applied: every command of ${a.proposal} was already applied or answered`, ...rows.map((r) => `  ${r.work_item_id}\t/${r.command}${r.args ? ` ${r.args}` : ""}\t${r.status}`)] };
      }
      await claim();
      // The controller's confirm path (src/controller/units/commands/proposals.ts) claims and applies each pending row,
      // and answers a refusal in the thread of the first pending command's item.
      const passport_id = await d.passport?.();
      const args = { item: pending[0]!.work_item_id, proposal: a.proposal };
      const { command } = await d.store.appendCliCommand({ key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command: CONFIRM_COMMAND, args, ...(passport_id ? { passport_id } : {}) });
      const n = pending.length === 1 ? "its pending command" : `its ${pending.length} pending commands`;
      return { code: 0, lines: [`stored \`factory confirm ${a.proposal}\` as ${user} (command ${command.seq}); the controller applies ${n} on its next poll`] };
    }
    case "help": {
      if (a.id === null) return { code: 0, lines: helpReply(null).split("\n") };
      const item = await d.store.getWorkItem(a.id);
      if (!item) return fail(`no work item ${a.id}`);
      return { code: 0, lines: helpReply(itemCommandState(item, await d.store.listRuns(item.id))).split("\n") };
    }
    case "users_list": {
      const users = await d.store.listLocalUsers();
      const names = (await d.displayNames?.([user, ...users.map((u) => u.user_id)])) ?? new Map<string, string>();
      const shown = (id: string) => (names.has(id) ? `${id} (${names.get(id)})` : id);
      return {
        code: 0,
        lines: [
          `you are ${shown(user)} (from ${d.identity.from})`,
          ...(users.length === 0 ? ["no local users yet: the first identity to run a writing command becomes the owner"] : []),
          ...users.map((u) => [shown(u.user_id), u.role, `added by ${u.added_by}`].join("\t")),
        ],
      };
    }
    case "users_add":
    case "users_remove": {
      const owner = await claim();
      if (owner?.user_id !== user) return fail(`only the local owner (${owner?.user_id ?? "none yet"}) can change roles; you are ${user}`);
      if (a.action === "users_remove") {
        const r = await d.store.removeLocalUser(a.user);
        if (r === "owner") return fail("the owner cannot be removed");
        return { code: 0, lines: [r === "removed" ? `removed ${a.user}` : `${a.user} had no role`] };
      }
      if (a.user === ANONYMOUS_USER && a.role !== "requester") return fail("anonymous gets read and create only: it cannot be an approver");
      const r = await d.store.setLocalUserRole(a.user, a.role, user);
      if (!r.ok) return fail(`${a.user} is the owner; the owner's role does not change`);
      return { code: 0, lines: [`${a.user} is now ${a.role === "approver" ? "an approver" : "a requester"}`] };
    }
  }
}

async function showLines(d: LocalCliDeps, item: WorkItem): Promise<string[]> {
  const out: string[] = [
    `${item.id}  ${item.title ?? ""}`,
    "",
    "State",
    `  stage: ${item.stage}`,
    `  blocked_on: ${item.blocked_on}`,
    `  blocked_reason: ${item.blocked_reason ?? "-"}`,
    `  close_reason: ${item.close_reason ?? "-"}`,
    `  tier: ${item.tier ?? "-"}`,
    `  change_ref: ${item.change_ref ?? "-"}`,
    `  version: ${item.version}`,
    "",
    "Spec",
  ];
  if (item.done_criteria === null) out.push("  (no spec yet)", `  problem: ${item.problem}`);
  else {
    out.push(`  problem: ${item.problem}`, "  done criteria:", ...item.done_criteria.map((c) => `    - ${c}`));
    out.push(`  desired output: ${item.desired_output ?? "-"}`, `  scope: ${item.scope ?? "-"}`, `  allowed paths: ${item.allowed_paths.join(", ")}`);
  }
  out.push("", "Sub-tasks");
  const subs = await d.store.listPhases(item.id);
  if (subs.length === 0) out.push("  (none)");
  for (const p of subs) out.push(`  ${p.phase ?? "-"}. ${p.id}\t${p.title ?? ""}\t${p.stage}\t${p.blocked_reason ?? "-"}`);
  out.push("", "Runs");
  const runs = await d.store.listRuns(item.id);
  if (runs.length === 0) out.push("  (none)");
  for (const r of runs) out.push(`  ${r.id}  ${r.kind}  ${r.status}  attempt ${r.attempt}`);
  out.push("", "Messages");
  const messages = await d.store.listItemMessages(item.id);
  if (messages.length === 0) out.push("  (none)");
  for (const m of messages) out.push(`  [${m.seq}] ${m.created_at}`, ...m.body.split("\n").map((l) => `    ${l}`));
  return out;
}

// `factory "<words>"` (design 04-gate-commands, the CLI sentence form): a command in the owner's own words, read by the
// plain-words reader over the open items. src/main.ts runs it for any first word no command claims. Each proposed
// command is printed as its typed line under the proposal ID and stored pending; `factory confirm <proposal-id>`
// applies them through the controller's confirm path. Nothing here changes an item's state.

export interface SentenceDeps {
  store: Pick<FactoryStore, "listWorkItemsWhere" | "recordCommandProposals">;
  llm: LLMProvider;
  scanner: Pick<EgressScanner, "scan">;
  identity: CliIdentity;
  /** The identity's refusal of approve_spec through the local auth plugin, or null when it may (as a plain reply is checked). */
  refusal: () => Promise<string | null>;
  /** A new random ID: the proposal's. */
  newId: () => string;
}

/** The words of `factory <words...>` as one sentence, or why they are none: a sentence has at least two words. */
export function parseSentence(args: readonly string[]): { text: string } | { error: string } {
  const text = args.join(" ").replace(/\s+/g, " ").trim();
  if (text.split(" ").length < 2) {
    return { error: `unknown command ${JSON.stringify(text)}; a command in your own words takes at least two words: factory ${SENTENCE_FORM}` };
  }
  if (text.length > INTERPRET_MAX_CHARS) return { error: `a command in your own words is at most ${INTERPRET_MAX_CHARS} characters` };
  return { text };
}

/**
 * Reads `text` as a message on no item: the role check, the egress scan of the words, one model call over the open
 * items, the egress scan of the answer; then a `commands` answer's proposals are stored pending under one new proposal
 * ID (`prop_` and the random ID's letters and digits) and printed as typed lines. Any other answer is printed as a
 * plain reply would read, without its hidden marker; nothing is stored.
 */
export async function runSentence(d: SentenceDeps, text: string): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  const refused = await d.refusal();
  if (refused !== null) return fail(`not read: ${refused}`);
  if (!(await d.scanner.scan("comment", text)).clean) return fail("not read: the words did not pass the egress scan, so they were not sent to the model");
  const items = openItems(await d.store.listWorkItemsWhere({ exclude_closed: true, limit: INTERPRET_MAX_ITEMS }));
  const result = await interpret(text, items, d.llm, "top_level");
  for (const t of interpretTexts(result)) if (!(await d.scanner.scan("comment", t)).clean) return fail("the model's answer did not pass the egress scan, so it is not shown");
  if (result.kind === "request") return { code: 0, lines: ["That reads as a work request, so nothing has changed: create it with `factory task create --title <t> --body-file <f>`."] };
  if (result.kind !== "commands") {
    const reply = interpretReply(result) ?? "The factory did not find a command in your words, so nothing changed.";
    return { code: 0, lines: reply.split("\n").filter((l) => !l.startsWith("<!--")) };
  }
  const id = `prop_${d.newId().replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 64);
  if (!isProposalId(id)) return fail("no proposal ID could be made");
  await d.store.recordCommandProposals(result.proposals.map((p, idx) => ({ proposal_id: id, idx, work_item_id: p.item.id, command: p.command, args: p.args, author_id: d.identity.user })));
  return {
    code: 0,
    lines: [
      `proposal ${id}: nothing has changed. To apply every command, run \`factory ${CONFIRM_WORD} ${id}\`; or type a line on its item.`,
      ...result.proposals.map((p) => `  ${p.item.id}\t${typed(p)}`),
    ],
  };
}
