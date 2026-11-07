import { parseComment } from "../../core/commands.js";
import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef, WorkItemId } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { CliCommand, FactoryStore } from "../../interfaces/factory-store.js";
import type { PollResult, PollSource, SourceCloseReason, SourceEvent } from "../../interfaces/source-adapter.js";

/** The most CLI commands one poll reads (issue #199); the rest come on the next poll. */
export const LOCAL_BATCH = 100;

/**
 * The `local` poll source (issue #199): intake from the store, not from a forge. `poll` reads the CLI command
 * log (`cli_commands`) after the cursor and turns each command for a local item into the event GitHub would
 * give for the same comment; `postComment` stores an item message. It never writes a command or creates an
 * item, and makes no network call.
 *
 * Command shape: `args.item` is the work item ID, `args.text` an optional string. The command is rebuilt as
 * `/<command> <text>` and read by the same comment parser GitHub uses. The cursor is the last `seq` read.
 */
export class LocalSource implements PollSource {
  readonly intake = "poll";
  readonly type = "local";

  constructor(private readonly store: FactoryStore) {}

  async poll(cursor: string | null): Promise<PollResult> {
    const after = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error(`local source: bad cursor ${JSON.stringify(cursor)}`);
    const commands = await this.store.listCliCommandsAfter(after, LOCAL_BATCH);
    const events: SourceEvent[] = [];
    let last = after;
    for (const c of commands) {
      last = Math.max(last, c.seq);
      const source = await this.itemSource(c);
      if (source === null) continue;
      const e = toEvent(c, source);
      if (e) events.push(e);
    }
    return { events, next_cursor: String(last) };
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const item = source.type === "local" ? await this.store.getWorkItemBySource("local", source.id) : null;
    if (!item) throw new Error(`local source: no local work item with source id ${JSON.stringify(source.id)}`);
    await this.store.recordItemMessage({ work_item_id: item.id, marker, body });
    return { url: null };
  }

  /** Nothing to mark: commands are read once, by cursor. */
  async markSeen(_source: SourceRef, _commentId: string | null): Promise<void> {}

  /** The store already holds the item's stage; there is no other surface to label. */
  async setStatus(_source: SourceRef, _status: WorkStatus, _pr_number: number | null): Promise<void> {}

  /** The store holds the item's state; there is nothing to close elsewhere. */
  async closeIssue(_source: SourceRef, _reason?: SourceCloseReason): Promise<void> {}

  /** The SourceRef of the command's item, or null when it names no item or a non-local one. */
  private async itemSource(c: CliCommand): Promise<SourceRef | null> {
    const id = c.args.item;
    if (typeof id !== "string" || id === "") return null;
    const item = await this.store.getWorkItem(id as WorkItemId);
    return item && item.source.type === "local" ? item.source : null;
  }
}

/** Provider `local`, subject the actor after `local:`. */
function identity(actor: string): ExternalIdentity {
  return { provider: "local", subject: actor.startsWith("local:") ? actor.slice("local:".length) : actor };
}

/** One command as the event the same comment on GitHub gives (src/impl/source/github-issue-source.ts). */
function toEvent(c: CliCommand, source: SourceRef): SourceEvent | null {
  const text = typeof c.args.text === "string" ? c.args.text : "";
  const body = text === "" ? `/${c.command}` : `/${c.command} ${text}`;
  const comment_id = c.key;
  const who = identity(c.actor);
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
      return { kind: "retry_requested", source, comment_id, requester: who };
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
