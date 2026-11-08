import { commentEvent } from "./comment-event.js";
import type { SourceRef } from "./types.js";
import { localIdentity } from "./local-cli.js";
import type { CliCommand, NewCliCommand } from "../interfaces/factory-store.js";
import type { SourceEvent } from "../interfaces/source-adapter.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";

/**
 * The command inbox's reader (issue #282; design 05-sources "Thread first"). A CLI command (`args.item` the work
 * item ID, `args.text` an optional string) is rebuilt as `/<command> <text>` and mapped by the one comment event
 * mapping (src/core/comment-event.ts) every source shares, so the controller handles it as the same comment:
 * the same event kinds, the same authorize check, the same replies. `comment_id` is the command's key; the
 * identity is provider `local`, subject the actor after `local:`, with the row's edge passport.
 */
export function commandEvent(c: CliCommand, source: SourceRef): SourceEvent | null {
  return commentEvent(source, c.key, commandIdentity(c, localIdentity(c.actor)), rebuilt(c));
}

/**
 * `identity` with the command row's edge passport (RFC 0015 §8) and the row's recorded time, which the controller's
 * authorize checks. A command never stored (a poll with no store) has neither.
 */
export function commandIdentity(c: Pick<NewCliCommand, "passport_id"> & Partial<Pick<CliCommand, "created_at">>, identity: ExternalIdentity): ExternalIdentity {
  if (c.passport_id === undefined) return identity;
  if (c.created_at === undefined) throw new Error("a command's passport is checked at the time its row was recorded");
  return { ...identity, passport: { id: c.passport_id, at: c.created_at } };
}

/** `/<command> <text>`, the comment a command row was read from or stands for. */
function rebuilt(c: NewCliCommand): string {
  const text = typeof c.args.text === "string" ? c.args.text : "";
  return text === "" ? `/${c.command}` : `/${c.command} ${text}`;
}

/** The PR a command on a PR's conversation was written on, as the forge poll read it: `change_ref` is its number as text. */
export interface CommandPr {
  change_ref: string;
  head_branch: string;
}

/** The key of a forge comment's row in the command inbox and its entry in the item thread (issue #284). */
export function githubCommentKey(comment_id: number): string {
  return `github:${comment_id}`;
}

const GITHUB_KEY = /^github:(\d+)$/;
const GITHUB_ACTOR = /^github:(\d+)$/;

/**
 * One forge comment command as a command inbox row (issue #284): key `github:<comment id>`, actor
 * `github:<numeric user id>` (never the login), `command` the word after `/`, `args.text` the text after it,
 * `args.source` the issue (or PR) it was written on, and `args.pr` the PR the poll read for a command on a
 * PR's conversation. Only the forge's comment poll writes these.
 */
export function githubCommand(c: {
  comment_id: number; user_id: number; command: string; text: string; source: SourceRef; pr?: CommandPr | null;
}): NewCliCommand {
  return {
    key: githubCommentKey(c.comment_id),
    actor: `github:${c.user_id}`,
    command: c.command,
    args: { source: c.source, text: c.text, ...(c.pr ? { pr: c.pr } : {}) },
  };
}

/**
 * The event of a row the forge's comment poll wrote (key `github:<comment id>`, actor `github:<numeric id>`), else
 * null: CLI and app rows never get provider `github`. The identity is provider `github` with the numeric id, so
 * that provider's auth plugin judges it; `comment_id` is the forge's comment id, so its 👀 and refusal replies are
 * keyed as before. A command on a PR's conversation gets the PR the poll read: `/revise` and `/resolve` as `pr`,
 * `/verdict` as its target. `source` is where it was written; `event` is null for a row that maps to no event.
 */
export function syncedCommand(c: NewCliCommand & Partial<Pick<CliCommand, "created_at">>): { source: SourceRef; event: SourceEvent | null } | null {
  const id = GITHUB_KEY.exec(c.key)?.[1];
  const subject = GITHUB_ACTOR.exec(c.actor)?.[1];
  const source = sourceRef(c.args.source);
  if (!id || !subject || !source) return null;
  const e = commentEvent(source, id, commandIdentity(c, { provider: "github", subject }), rebuilt(c));
  const pr = commandPr(c.args.pr);
  if (!e || !pr) return { source, event: e };
  if (e.kind === "revise_requested" || e.kind === "resolve_requested") return { source, event: { ...e, pr } };
  if (e.kind === "verdict_submitted") return { source, event: { ...e, target: { kind: "pr", ...pr } } };
  return { source, event: e };
}

function sourceRef(v: unknown): SourceRef | null {
  const r = v as Partial<SourceRef> | null;
  return r && typeof r === "object" && typeof r.type === "string" && typeof r.id === "string" && typeof r.link === "string"
    ? { type: r.type, id: r.id, link: r.link }
    : null;
}

/**
 * `args.pr` of a row: `change_ref` as written now, or the legacy `pr_number` (a number) of a row queued before the
 * rename (design 02), so a row that waited across the upgrade maps to the same event. The legacy read goes once no
 * stored row can hold it (see design 02, History).
 */
function commandPr(v: unknown): CommandPr | null {
  const p = v as (Partial<CommandPr> & { pr_number?: unknown }) | null;
  if (!p || typeof p !== "object" || typeof p.head_branch !== "string") return null;
  if (typeof p.change_ref === "string" && p.change_ref !== "") return { change_ref: p.change_ref, head_branch: p.head_branch };
  if (typeof p.pr_number === "number" && Number.isSafeInteger(p.pr_number)) return { change_ref: String(p.pr_number), head_branch: p.head_branch };
  return null;
}
