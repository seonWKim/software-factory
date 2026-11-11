import { VERDICT_SEVERITIES, type ParsedVerdict } from "./verdict.js";

// Pure mapping from a 👍 or 👎 on a factory message to the verdict `/verdict` would store (design §4, issue #524).
// No I/O: the sources read the reactions, the verdicts unit stores what this returns.

/** A reaction that means a verdict: 👍 (`+1`) or 👎 (`-1`). */
export type VerdictReaction = "+1" | "-1";

/** How far back reactions are read: a reaction on a factory message posted longer ago is ignored (no backfill). */
export const REACTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The verdict reaction an emoji name means, or null for any other emoji (the bot's own 👀 included). GitHub names
 * them `+1` and `-1`; Slack `+1`/`thumbsup` and `-1`/`thumbsdown`, with an optional skin tone (`+1::skin-tone-2`).
 */
export function verdictReaction(emoji: string): VerdictReaction | null {
  const name = emoji.replace(/::skin-tone-\d$/, "");
  if (name === "+1" || name === "thumbsup") return "+1";
  if (name === "-1" || name === "thumbsdown") return "-1";
  return null;
}

/** The comment id a reaction's verdict is stored under, so a redelivered reaction stores nothing more. */
export function reactionKey(reaction_id: string): string {
  return `reaction:${reaction_id}`;
}

/** Whether a reaction at `reacted_ms` on a message posted at `posted_ms` (both ms since the epoch) is still read. */
export function inReactionWindow(posted_ms: number, reacted_ms: number): boolean {
  return reacted_ms - posted_ms <= REACTION_WINDOW_MS;
}

/**
 * The one follow-up a 👎 gets: fixed text that quotes nothing the person wrote. Their `/verdict changes` reply is
 * what stores the verdict; a 👎 with no reply stores nothing.
 */
export const SEVERITY_FOLLOW_UP =
  "Thanks for the 👎. To record it as a verdict, reply `/verdict changes <severity> <reason>`, with severity one of " +
  `${VERDICT_SEVERITIES.map((s) => `\`${s}\``).join(", ")}. Nothing is stored until you reply.`;

/** What a reaction does: 👍 stores `accept` with severity `none`; 👎 asks for the severity first. */
export type ReactionOutcome = { kind: "record"; verdict: ParsedVerdict } | { kind: "ask"; body: string };

export function reactionOutcome(r: VerdictReaction): ReactionOutcome {
  return r === "+1"
    ? { kind: "record", verdict: { verdict: "accept", severity: "none", reason: null } }
    : { kind: "ask", body: SEVERITY_FOLLOW_UP };
}

/** The key of a 👎's follow-up message, one per reaction: from the reaction's stored key (reactionKey). */
export function followUpKey(reaction_key: string): string {
  return `severity-${reaction_key}`;
}
