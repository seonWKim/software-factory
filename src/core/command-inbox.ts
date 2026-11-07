import { parseComment } from "./commands.js";
import type { SourceRef } from "./types.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";
import type { CliCommand } from "../interfaces/factory-store.js";
import type { SourceEvent } from "../interfaces/source-adapter.js";

/**
 * The command inbox's reader (issue #282; design 05-sources "Thread first"). A CLI command (`args.item` the work
 * item ID, `args.text` an optional string) is rebuilt as `/<command> <text>` and read by the same comment parser
 * GitHub comments use, so the controller handles it as the same comment: the same event kinds, the same authorize
 * check, the same replies. `comment_id` is the command's key; the identity is provider `local`, subject the actor
 * after `local:`.
 */
export function commandEvent(c: CliCommand, source: SourceRef): SourceEvent | null {
  const text = typeof c.args.text === "string" ? c.args.text : "";
  const body = text === "" ? `/${c.command}` : `/${c.command} ${text}`;
  const comment_id = c.key;
  const who = commandIdentity(c.actor);
  const parsed = parseComment(body);
  if (parsed === null) return { kind: "plain_comment", source, comment_id, author: who, body };
  if (parsed.kind === "unknown") return { kind: "unknown_command", source, comment_id, requester: who, command: parsed.word };
  const t = parsed.text;
  switch (parsed.name) {
    case "approve":
      return { kind: "spec_approved", source, comment_id, approver: who, note: t };
    case "reject":
      return { kind: "spec_rejected", source, comment_id, approver: who, reason: t };
    case "revise":
      return { kind: "revise_requested", source, comment_id, requester: who, feedback: t };
    case "retry":
      return { kind: "retry_requested", source, comment_id, requester: who, ...(t ? { note: t } : {}) };
    case "budget": {
      const amount = (t.split(/\r?\n/)[0] ?? "").trim();
      return { kind: "budget_continue", source, comment_id, approver: who, amount: amount === "" ? null : amount };
    }
    case "resolve":
      return { kind: "resolve_requested", source, comment_id, requester: who, notes: t, pr: null };
    case "help":
      return { kind: "help_requested", source, comment_id, requester: who };
    case "verdict":
      return { kind: "verdict_submitted", target: { kind: "issue", source }, comment_id, approver: who, args: t };
    default:
      return null;
  }
}

/** Provider `local`, subject the actor after `local:`. */
export function commandIdentity(actor: string): ExternalIdentity {
  return { provider: "local", subject: actor.startsWith("local:") ? actor.slice("local:".length) : actor };
}
