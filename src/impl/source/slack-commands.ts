import { type ChatCommand, type CommandWho, type TableCommand, chatCliArgv, cliUsageOf } from "../../core/command-table.js";
import { chatForm, chatHelpReply, commandSpec, commandState } from "../../core/commands.js";
import { CONFIRM_COMMAND, isProposalId } from "../../core/interpret.js";
import { type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../../core/local-cli.js";
import type { UserId, WorkItem } from "../../core/types.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import { ACTION_PROPOSAL, ACTION_PROPOSAL_ALL, ACTION_PROPOSAL_CANCEL } from "./slack-format.js";

// Factory commands typed in Slack (issue #498; docs/plugins/source-adapter.md, `slack`): the command table's chat
// forms (src/core/command-table.ts) run as the factory user the Slack account is linked to. Reads print what the CLI
// prints; item commands and `merge` store the CLI's command row through the CLI's own code (runLocalCli), with the
// linked user as actor, and the controller applies it and answers in the thread. No Slack call happens here: the
// caller posts the answer after this returns, so a command is stored before any Slack call.

/**
 * What a chat command answers in its thread: Markdown, a command's printed lines (with `whole`, the CLI command that
 * prints them, and `link`, the shown item's source, for the note on a cut reply), or nothing.
 */
export type ChatAnswer = { markdown: string } | { lines: string[]; whole: string; link?: string } | null;

export type ChatStore = LocalCliDeps["store"] &
  Pick<FactoryStore, "resolveLink" | "getLocalUser" | "listLocalUsers" | "listCommandProposals" | "answerCommandProposal">;

export interface ChatDeps {
  store: ChatStore;
  /** `settings list` and `settings history` (`runSettings` over the config file's settings); absent: not available. */
  settings?: (args: readonly string[]) => Promise<{ ok: boolean; lines: string[] }>;
}

export interface ChatContext {
  /** The Slack user ID that typed it (provider `slack`). Never a display name. */
  user: string;
  /** The work item whose thread it was typed in, else null. */
  item: WorkItem | null;
  /** The same for every delivery of one message or press: a stored command's key is `cli:<id>`, so it is stored once. */
  id: string;
  /** The source type it was typed in: a command on that source's own item is not mirrored back to it. */
  origin: string;
}

const UNLINKED =
  "This Slack account is not linked to a factory user, so the command was not run. To link it, run `factory link-code <user_id>` " +
  "and post `/link <code>` here after a mention of the bot. Until then only `/link` and `help` are answered.";

function unlinkedHelp(): string {
  return [
    "This Slack account is not linked to a factory user. Commands you can run here (mention the bot first):",
    `- \`${commandSpec("link").usage}\`: ${commandSpec("link").description}.`,
    `- \`help\`: ${commandSpec("help").description}.`,
  ].join("\n");
}

/** The refusal of a write that waits for chat edge passports (#479). */
export function edgeRefusal(c: TableCommand): string {
  return `\`${c.name}\` was not run: from Slack, writes to users, settings and the mode wait for signed command passports (issue #479). ` +
    `Run \`factory ${cliUsageOf(c)}\` from the command line. Reads (\`users list\`, \`settings list\`, \`settings history\`) work here.`;
}

/**
 * What the linked user's stored role allows (design 08-permissions): the owner everything, an approver the approve
 * actions, anyone else reads and requests. While no owner is stored, the first user to write becomes it, as on the
 * CLI, so they may write. Only for `help`'s list: the controller checks every command again when it applies it.
 */
async function mayOf(store: ChatStore, user: UserId): Promise<(w: CommandWho) => boolean> {
  const row = await store.getLocalUser(user);
  const owner = row?.role === "owner" || (!row && !(await store.listLocalUsers()).some((u) => u.role === "owner"));
  const approver = owner || row?.role === "approver";
  return (w) => w === "anyone" || w === "submit_work" || (w === "owner" ? owner : approver);
}

/** Runs one chat command; the answer to post in its thread, or null when the controller answers. */
export async function runChatCommand(d: ChatDeps, cmd: ChatCommand, ctx: ChatContext): Promise<ChatAnswer> {
  const user = await d.store.resolveLink("slack", ctx.user);
  if (user === null) return { markdown: cmd.kind === "help" ? unlinkedHelp() : UNLINKED };
  if (cmd.kind === "help") return { markdown: chatHelpReply(await mayOf(d.store, user), ctx.item ? commandState(ctx.item) : null) };
  const c = cmd.entry;
  if (c.edge) return { markdown: edgeRefusal(c) };
  if (c.item && ctx.item === null) return { markdown: `\`${chatForm(c.chat)}\` works only in a work item's thread: post it there, after a mention of the bot.` };
  const argv = chatCliArgv(cmd, ctx.item?.id ?? null);
  const whole = ["factory", argv.word, ...argv.args].join(" ");
  if (c.group === "settings") {
    if (!d.settings) return { markdown: "Settings cannot be read from Slack here; run `factory settings list` from the command line." };
    return { lines: (await d.settings(argv.args)).lines, whole };
  }
  const action = parseLocalCliArgs(argv.word, argv.args);
  if ("error" in action) return { lines: action.error.split("\n"), whole };
  const r = await runLocalCli(
    {
      store: d.store,
      identity: { user, from: "linked chat account" },
      project: async () => null,
      read: () => Promise.reject(new Error("chat commands read no files")),
      newId: () => ctx.id,
      origin: ctx.origin,
    },
    action,
  );
  // A stored item command: the controller applies it and answers in the thread (one reply, refusals included).
  if (c.item && r.code === 0) return null;
  const shown = action.action === "show" ? await d.store.getWorkItem(action.id) : null;
  return { lines: r.lines, whole, ...(shown ? { link: shown.source.link } : {}) };
}

/** A press of a stored proposal's button (issue #584): Confirm one command (its index) or all (index null), or Cancel. */
export type ProposalPress = { kind: "confirm"; id: string; index: number | null } | { kind: "cancel"; id: string };

/** The proposal press an action means, or null: another button, or a value not shaped as one (values are untrusted). */
export function proposalPress(action_id: string, value: string | null): ProposalPress | null {
  if (value === null) return null;
  if (action_id === ACTION_PROPOSAL_ALL) return isProposalId(value) ? { kind: "confirm", id: value, index: null } : null;
  if (action_id === ACTION_PROPOSAL_CANCEL) return isProposalId(value) ? { kind: "cancel", id: value } : null;
  const m = /^([^:]+):(\d{1,2})$/.exec(value);
  if (!m || !isProposalId(m[1]!) || action_id !== `${ACTION_PROPOSAL}:${m[2]}`) return null;
  return { kind: "confirm", id: m[1]!, index: Number(m[2]) };
}

/**
 * A proposal press in an item's thread (issue #584), as the linked factory user; an unlinked presser gets the one
 * refusal a typed command gets, and nothing is stored. Cancel marks the proposal's pending rows cancelled and stores
 * no command. Confirm stores one `proposal_confirm` command row keyed on the press (`cli:<id>`, so a redelivery stores
 * nothing more) and answers nothing here: the controller reads the rows' args from the store, applies each through the
 * typed command's path and check, and replies in the thread.
 */
export async function runProposalPress(d: ChatDeps, p: ProposalPress, ctx: ChatContext): Promise<ChatAnswer> {
  const user = await d.store.resolveLink("slack", ctx.user);
  if (user === null) return { markdown: UNLINKED };
  if (ctx.item === null) return null;
  if (p.kind === "confirm") {
    const args = { item: ctx.item.id, proposal: p.id, ...(p.index === null ? {} : { index: p.index }) };
    await d.store.appendCliCommand({ key: `cli:${ctx.id}`, actor: user, command: CONFIRM_COMMAND, args });
    return null;
  }
  let cancelled = 0;
  for (const r of await d.store.listCommandProposals(p.id)) {
    if (r.status !== "pending") continue;
    if (await d.store.answerCommandProposal({ proposal_id: r.proposal_id, idx: r.idx, from: "pending", to: "cancelled", answered_by: user })) cancelled++;
  }
  return {
    markdown: cancelled > 0
      ? `Cancelled by \`${user}\`: the proposed ${cancelled === 1 ? "command was" : "commands were"} not applied, and no command was stored.`
      : "Nothing to cancel: every command of this proposal was already applied or answered.",
  };
}
