import type { ParsedVerdict } from "./verdict.js";
import type { PostedComment } from "../interfaces/factory-store.js";
import type { ReactionTarget, SourceEvent } from "../interfaces/source-adapter.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";

// Pure mapping from a 👍 or 👎 on a factory message to the verdict `/verdict` would store (design §4, issue #524).
// No I/O: the sources read the reactions and build the events with it, the verdicts unit stores them.

/** A reaction that means a verdict: 👍 (`+1`) or 👎 (`-1`). */
export type VerdictReaction = "+1" | "-1";

/** How far back reactions are read: a reaction on a factory message posted longer ago is ignored (no backfill). */
export const REACTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The verdict reaction an emoji name means, or null for any other emoji (the bot's own 👀 included). A forge names
 * them `+1` and `-1`; chat `+1`/`thumbsup` and `-1`/`thumbsdown`, with an optional skin tone (`+1::skin-tone-2`).
 */
export function verdictReaction(emoji: string): VerdictReaction | null {
  const name = emoji.replace(/::skin-tone-\d$/, "");
  if (name === "+1" || name === "thumbsup") return "+1";
  if (name === "-1" || name === "thumbsdown") return "-1";
  return null;
}

/**
 * The verdict a reaction stores at once: 👍 is `accept` with severity `none`. Null for 👎: it asks for the severity
 * first, and the person's `/verdict changes <severity> <reason>` reply is what stores it.
 */
export function reactionVerdict(r: VerdictReaction): ParsedVerdict | null {
  return r === "+1" ? { verdict: "accept", severity: "none", reason: null } : null;
}

/** The comment id a reaction's verdict is stored under, so a redelivered reaction stores nothing more. */
export function reactionKey(reaction_id: string): string {
  return `reaction:${reaction_id}`;
}

/** Whether a reaction at `reacted_ms` on a message posted at `posted_ms` (both ms since the epoch) is still read. */
export function inReactionWindow(posted_ms: number, reacted_ms: number): boolean {
  return reacted_ms - posted_ms <= REACTION_WINDOW_MS;
}

/** The one reaction event of a person's verdict reaction. */
export function reactionEvent(target: ReactionTarget, reaction_id: string, who: ExternalIdentity, r: VerdictReaction): SourceEvent {
  return { kind: "verdict_submitted", target, comment_id: reactionKey(reaction_id), approver: who, reaction: r, verdict: reactionVerdict(r) };
}

/** The posted records that are comments on a change (their URL names `/pull/<n>`), each comment once, with its change ref. */
export function changeComments(posted: readonly PostedComment[]): { comment_id: string; change_ref: string }[] {
  const out = new Map<string, string>();
  for (const p of posted) {
    const n = /\/pull\/(\d+)(?:#|$)/.exec(p.url ?? "")?.[1];
    if (n && p.comment_id !== null && !out.has(p.comment_id)) out.set(p.comment_id, n);
  }
  return [...out].map(([comment_id, change_ref]) => ({ comment_id, change_ref }));
}

/** A reaction as a forge lists it: `user` null for a deleted account, `type` `Bot` for a bot (the factory itself). */
export interface ListedReaction {
  id: number;
  content: string;
  user: { id: number; login: string; type: string } | null;
}

/**
 * One comment's reaction list read again: the events of the verdict reactions by people above `mark` (the highest
 * reaction id already delivered), oldest first, and the new mark. Other emoji and bots move the mark, nothing else.
 */
export function newReactionEvents(
  list: readonly ListedReaction[], mark: number, target: ReactionTarget, who: (u: NonNullable<ListedReaction["user"]>) => ExternalIdentity,
): { events: SourceEvent[]; mark: number } {
  const events: SourceEvent[] = [];
  let next = mark;
  for (const r of [...list].sort((a, b) => a.id - b.id)) {
    if (r.id <= mark) continue;
    next = Math.max(next, r.id);
    const v = verdictReaction(r.content);
    if (v !== null && r.user !== null && r.user.type !== "Bot") events.push(reactionEvent(target, String(r.id), who(r.user), v));
  }
  return { events, mark: next };
}

/** The store reads reactions need (issue #524), on the posted-comment records; read-only, no schema change. */
export interface PostedCommentReads {
  /**
   * The posted records whose comment ID is `comment_id`, oldest first (a chat message's ts can be recorded under more
   * than one marker, e.g. its button update). Rows of failed posts only are never returned.
   */
  listPostedCommentsById(comment_id: string): Promise<PostedComment[]>;
  /**
   * The comments posted on sources whose id starts with `source_prefix` (e.g. `owner/name#`) in the last `within_ms`
   * by the store clock, oldest first. Rows of failed posts only are never returned.
   */
  listPostedComments(source_prefix: string, within_ms: number): Promise<PostedComment[]>;
}
