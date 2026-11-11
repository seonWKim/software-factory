// Stored command proposals (design 04-gate-commands, issue #584): a plain-language reply's proposals stored once, and
// the confirm path of a press (Slack's proposal buttons, slack-commands.ts), which stores one `proposal_confirm`
// command row as the presser's linked factory user, and of `factory confirm` (the same row, as the CLI identity); the
// dashboard's sentence, Confirm all and Cancel (app requests, `appProposal`); and the one answer to a plain message. Each pending command it names goes through the typed command's
// path (CommandsUnit.gateCommand): the same AuthProvider check, note scan and state checks. Imports only the
// controller's own modules; what needs the legacy core comes in from the commands unit (`ConfirmDeps`). Its store
// I/O is inline, as the commands unit's is (unit-purity ratchet): the kernel has no proposal write yet.

import { createHash } from "node:crypto";
import { COMMAND, type CommandEvent } from "../support.js";
import type { Ctx } from "../context.js";
import type { CommandsUnit } from "./commands.unit.js";

type Store = Ctx["k"]["d"]["store"];
type Proposal = Awaited<ReturnType<Store["listCommandProposals"]>>[number];
type Item = Parameters<CommandsUnit["gateCommand"]>[0];
type InboxCommand = Parameters<CommandsUnit["handleInboxCommand"]>[0];
type AppRequest = Parameters<CommandsUnit["appProposal"]>[0];
type PlainMessage = NonNullable<Parameters<CommandsUnit["readMessage"]>[2]>["e"];

/** The interpretation's shape this file reads: a `commands` answer's proposals. */
interface Answer {
  kind: string;
  proposals?: readonly { item: { id: Proposal["work_item_id"] }; command: Proposal["command"]; args: string }[];
}

/** What the confirm path needs from the legacy core, bound by the commands unit to the presser's command row. */
export interface ConfirmDeps {
  /** The proposed command as the event its typed line is, from the presser, on `source`; null when it maps to none. */
  event: (row: Proposal, source: Item["source"]) => { kind: string } | null;
  /** The refusal reply's text: `command` was not applied, and why. */
  say: (command: string, reason: string) => string;
}

/** What the dashboard's requests need beside a confirm's: the request's user as an identity, and the item's command list. */
export interface AppProposalDeps extends ConfirmDeps {
  /** The request's user, `local` with its edge passport, as a typed command from it is checked. */
  who: PlainMessage["author"];
  /** The commands that apply to the item now, for an answer with no command in it. */
  footer: () => Promise<string>;
}

/** The answer to a message the reader found no command in, above the item's command list. */
const NO_COMMAND = "The factory did not find a command in your comment, so nothing changed.";

/**
 * One plain message `e` on `item` (a comment, or the dashboard's sentence keyed on its request), read by the commands
 * unit's `readMessage`, answered once in the item's thread, keyed on the message: commands proposed for any open item
 * as typed lines (stored once as pending proposal rows, which Slack shows as buttons), a read answered, one question,
 * or a plain-words answer from the item's state label and block reason. Only a failed or malformed model answer gets
 * the fixed line and `footer`. Changes no item state. `unread` or `blocked` when nothing is posted.
 */
export async function answerPlain(c: Ctx, item: Item, e: PlainMessage, footer: () => Promise<string>): Promise<"unread" | "blocked" | null> {
  const read = await c.unit("commands").readMessage(e.body, { work_item_id: item.id }, { item, e });
  if (typeof read === "string") return read;
  c.k.d.log.info("plain comment answered", { work_item_id: item.id, kind: read.kind });
  await c.unit("outbox").post(item, item.source, read.body ?? [NO_COMMAND, "", await footer()].join("\n"), `<!-- factory:suggest:${e.comment_id} -->`);
  return null;
}

/**
 * The dashboard's requests on `item`, keyed `key` (design 09-dashboard-app), as the request's user: Confirm all
 * (`args.proposal`) goes through `confirmProposal`, as a `factory confirm` row does, each command checked as typed;
 * Cancel and a sentence (`args.note`) need approve_spec first, as a plain reply's author does. Cancel marks the pending
 * rows cancelled and stores no command, with one reply, as Slack's Cancel does; a sentence is a plain message keyed
 * on the request. The refusal, or null.
 */
export async function appProposal(c: Ctx, r: AppRequest, item: Item, key: string, kind: "confirm" | "cancel" | "sentence", deps: AppProposalDeps): Promise<string | null> {
  const proposal = typeof r.args.proposal === "string" ? r.args.proposal : "";
  if (kind === "confirm") {
    await confirmProposal(c, { key, actor: r.actor, args: { proposal } }, item, deps);
    return null;
  }
  const principal = await c.unit("auth").authorize(deps.who, "approve_spec", item.id);
  if ("refuse" in principal) return principal.refuse;
  if (kind === "sentence") {
    const body = typeof r.args.note === "string" ? r.args.note : "";
    const read = await answerPlain(c, item, { kind: "plain_comment", source: item.source, comment_id: key, author: deps.who, body }, deps.footer);
    if (read === "unread") return "the words were not read: they were empty or too long, did not pass the egress scan, or no model is configured";
    return read === "blocked" ? "the model's answer did not pass the egress scan, so it is not shown" : null;
  }
  let cancelled = 0;
  for (const row of await c.k.d.store.listCommandProposals(proposal)) {
    if (row.status !== "pending") continue;
    if (await c.k.d.store.answerCommandProposal({ proposal_id: row.proposal_id, idx: row.idx, from: "pending", to: "cancelled", answered_by: r.actor })) cancelled++;
  }
  const body = cancelled > 0
    ? `Cancelled by \`${r.actor}\`: the proposed ${cancelled === 1 ? "command was" : "commands were"} not applied, and no command was stored.`
    : "Nothing to cancel: every command of this proposal was already applied or answered.";
  await c.unit("outbox").post(item, item.source, body, `<!-- factory:proposal-cancelled:${key} -->`);
  return null;
}

/** The proposal ID of the reply to comment `comment_id` on item `item`: the same for every delivery of that comment. */
export function proposalId(item: string, comment_id: string): string {
  return `prop_${createHash("sha256").update(`${item}\n${comment_id}`).digest("hex").slice(0, 32)}`;
}

/**
 * Stores a `commands` answer's proposals, one pending row per command keyed by (proposal ID, index), and returns
 * the proposal ID for the reply's marker; null for any other answer. Storing the same reply again writes nothing.
 */
export async function storeProposals(c: Ctx, item: Item, e: { comment_id: string; author: { provider: string; subject: string } }, r: Answer): Promise<string | null> {
  if (r.kind !== "commands" || !r.proposals?.length) return null;
  const id = proposalId(item.id, e.comment_id);
  const author_id = `${e.author.provider}:${e.author.subject}`;
  await c.k.d.store.recordCommandProposals(r.proposals.map((p, idx) => ({ proposal_id: id, idx, work_item_id: p.item.id, command: p.command, args: p.args, author_id })));
  return id;
}

/** A row that was already answered, as the reply lists it. */
function answeredLine(r: Proposal): string {
  const line = r.args ? `/${r.command} ${r.args}` : `/${r.command}`;
  const how = r.status === "refused" ? `was refused: ${r.refusal ?? "no reason stored"}` : `was already ${r.status}`;
  return `- \`${line}\` on \`${r.work_item_id}\` ${how}${r.answered_by ? ` (by ${r.answered_by})` : ""}.`;
}

/**
 * A confirm press's command row (`args.proposal`, `args.index`; no index: confirm all) on the thread's item `at`.
 * Each pending row it names, in index order, is claimed (pending → applied, conditional, so a second confirm, a
 * redelivery or another replica applies it once) and then applied through the typed path as the row's actor; a
 * refusal marks the row refused and gets one reply saying why, keyed on the row. One refused command does not stop
 * the next. A confirm that finds nothing pending applies nothing and gets one reply, keyed on its command row, saying
 * what already happened. A stop between the claim and the apply leaves the row applied with nothing applied: the
 * person types the line, which the reply keeps.
 */
export async function confirmProposal(c: Ctx, cmd: Pick<InboxCommand, "key" | "actor" | "args">, at: Item, deps: ConfirmDeps): Promise<void> {
  const store = c.k.d.store;
  const proposal = typeof cmd.args.proposal === "string" ? cmd.args.proposal : "";
  const index = typeof cmd.args.index === "number" ? cmd.args.index : null;
  const rows = (await store.listCommandProposals(proposal)).filter((r) => index === null || r.idx === index);
  let claimed = 0;
  for (const r of rows) {
    if (r.status !== "pending") continue;
    if (!(await store.answerCommandProposal({ proposal_id: r.proposal_id, idx: r.idx, from: "pending", to: "applied", answered_by: cmd.actor }))) continue;
    claimed++;
    const refusal = await apply(c, r, deps);
    if (refusal === null) continue;
    await store.answerCommandProposal({ proposal_id: r.proposal_id, idx: r.idx, from: "applied", to: "refused", answered_by: cmd.actor, refusal });
    c.k.d.log.info("proposed command refused", { work_item_id: r.work_item_id, command: r.command, reason: refusal });
    await c.unit("outbox").post(at, at.source, deps.say(`/${r.command}`, refusal), `<!-- factory:proposal-refused:${r.proposal_id}:${r.idx} -->`);
  }
  if (claimed > 0) return;
  const now = (await store.listCommandProposals(proposal)).filter((r) => index === null || r.idx === index);
  const body = now.length === 0
    ? "Nothing was applied: that proposal is not stored here."
    : ["Nothing was applied this time: the proposed command was already applied or answered.", ...now.map(answeredLine)].join("\n");
  await c.unit("outbox").post(at, at.source, body, `<!-- factory:proposal-answered:${cmd.key} -->`);
}

/** One claimed row through the typed command's path on its own item; the refusal reason, else null. */
async function apply(c: Ctx, r: Proposal, deps: ConfirmDeps): Promise<string | null> {
  const item = await c.k.reader.getWorkItem(r.work_item_id);
  if (!item) return "the work item is no longer stored";
  const e = deps.event(r, item.source);
  if (!e || !(e.kind in COMMAND)) return "it is not a command a proposal can apply";
  return c.unit("commands").gateCommand(item, e as CommandEvent);
}
