// The info and link replies: `/help` or an unknown command on a work item, and `/link <code>` on any issue. Moved out
// of the commands unit (issue #866) with no change in behaviour; the unit's event map and handlePlainComment call them,
// the info reply with its text from the legacy core (InfoSay), so this file imports only the controller's own modules.

import type { ControllerEvent, Ctx } from "../context.js";
import type { CommandsUnit } from "./commands.unit.js";

type InfoEvent = Extract<ControllerEvent, { kind: "help_requested" | "unknown_command" }>;
type PlainCommentEvent = Extract<ControllerEvent, { kind: "plain_comment" }>;
type RedeemLinkResult = Awaited<ReturnType<Ctx["k"]["redeemLinkCode"]>>;
type State = Awaited<ReturnType<CommandsUnit["stateOf"]>>;

/** The info replies' text, from the legacy core (helpReply, unknownCommandReply), passed in by the commands unit. */
export interface InfoSay {
  help: (s: State) => string;
  unknown: (word: string, s: State) => string;
}

/** Why a `/link` code was refused, as the reply says it. Never names the code. */
const LINK_REFUSALS: Record<Exclude<RedeemLinkResult, { ok: true }>["reason"], string> = {
  invalid: "the code is wrong",
  expired: "the code has expired (codes work for 10 minutes)",
  used: "the code was already used",
  locked: "the code is locked after too many wrong codes",
  already_linked: "this account is already linked to another factory user",
};

/**
 * `/help` or an unknown command on a work item: 👀, then one reply keyed on the comment id, listing the
 * commands for the item's current state. Like other commands, ignored entirely on an issue that is not one.
 */
export async function handleInfo(c: Ctx, e: InfoEvent, say: InfoSay): Promise<void> {
  const item = await c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
  if (!item) return;
  await c.unit("outbox").markSeen(e.source, e.comment_id);
  const state = await c.unit("commands").stateOf(item);
  const help = e.kind === "help_requested";
  await c.unit("outbox").post(
    item,
    item.source,
    help ? say.help(state) : say.unknown(e.command, state),
    `<!-- factory:${help ? "help" : "unknown"}:${e.comment_id} -->`,
  );
}

/**
 * `/link <code>` (design 2026-11-01): links the commenter's account to the code's factory user. On any issue,
 * work item or not. One reply keyed on the comment id; the code is never logged or echoed. A wrong code is a
 * failed attempt (the store counts it) and links nothing. A redelivery of a used code reports the same link.
 */
export async function handleLink(c: Ctx, e: PlainCommentEvent, code: string): Promise<void> {
  const account = { provider: e.author.provider, subject: e.author.subject };
  const r = code === "" ? ({ ok: false, reason: "invalid" } as const) : await c.k.redeemLinkCode(code, account);
  await c.unit("outbox").markSeen(e.source, e.comment_id);
  c.k.d.log.info("link attempt", { provider: account.provider, ok: r.ok, ...(r.ok ? { user_id: r.user_id } : { reason: r.reason }) });
  const body = r.ok
    ? `This account is now linked to factory user \`${r.user_id}\`. Commands from it act as that user.`
    : `This account was not linked: ${LINK_REFUSALS[r.reason]}. Ask for a new code with \`factory link-code <user_id>\`.`;
  const item = await c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
  if (item) await c.unit("outbox").post(item, e.source, body, `<!-- factory:link:${e.comment_id} -->`);
  else await c.unit("outbox").postWithoutItem(e.source, body, `<!-- factory:link:${e.comment_id} -->`);
}
