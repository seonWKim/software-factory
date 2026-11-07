import { parseComment } from "./commands.js";
import type { SourceRef } from "./types.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";
import type { SourceEvent } from "../interfaces/source-adapter.js";

/**
 * One comment on an item as the event a source issue comment with the same text gives, read by the one comment
 * parser (src/core/commands.ts): a command, an unknown command word, or a plain comment (`/link` included).
 * The one copy (issue #282): the command inbox reader (src/core/command-inbox.ts, local CLI and app commands) and
 * the Slack source use it, so their event kinds cannot drift from the issue source's.
 * `resolve` gets `pr: null` and `revise` no `pr`; `verdict` targets the item itself.
 */
export function commentEvent(source: SourceRef, comment_id: string, who: ExternalIdentity, body: string): SourceEvent | null {
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
    case "standing":
      return { kind: "standing_requested", source, comment_id, requester: who, args: t };
    default:
      return null;
  }
}
