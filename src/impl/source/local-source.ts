import { parseComment } from "../../core/commands.js";
import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef, WorkItemId } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { CliCommand, FactoryStore } from "../../interfaces/factory-store.js";
import type { PollResult, PollSource, SourceCloseReason, SourceEvent } from "../../interfaces/source-adapter.js";

/** Commands read per poll; the rest come on the next poll. */
export const LOCAL_BATCH = 100;

const ACTOR_PREFIX = "local:";

/**
 * Local intake (issue #199): a poll source that reads the CLI command log in the store and turns each command
 * on a local item into the same event a GitHub comment with that command would give. Replies are stored as
 * item messages. Nothing here writes commands or creates items.
 *
 * Command shape: `args.item` is the work item ID, `args.text` an optional string. The command is rebuilt as
 * `/<command> <text>` and read by the same parser as GitHub comments. The cursor is the last seq read, as a
 * string; an empty or null cursor means 0.
 */
export class LocalSource implements PollSource {
  readonly type = "local" as const;
  readonly intake = "poll" as const;

  constructor(private readonly store: FactoryStore) {}

  async poll(cursor: string | null): Promise<PollResult> {
    const after = parseCursor(cursor);
    const commands = await this.store.listCliCommandsAfter(after, LOCAL_BATCH);
    const events: SourceEvent[] = [];
    let last = after;
    for (const cmd of commands) {
      last = Math.max(last, cmd.seq);
      const event = await this.toEvent(cmd);
      if (event) events.push(event);
    }
    return { events, next_cursor: String(last) };
  }

  private async toEvent(cmd: CliCommand): Promise<SourceEvent | null> {
    const itemId = cmd.args["item"];
    if (typeof itemId !== "string" || itemId === "") return null;
    if (!cmd.actor.startsWith(ACTOR_PREFIX) || cmd.actor.length === ACTOR_PREFIX.length) return null;
    const item = await this.store.getWorkItem(itemId as WorkItemId);
    if (!item || item.source.type !== "local") return null;

    const source: SourceRef = item.source;
    const comment_id = cmd.key;
    const who: ExternalIdentity = { provider: "local", subject: cmd.actor.slice(ACTOR_PREFIX.length) };
    const rawText = cmd.args["text"];
    const body = `/${cmd.command} ${typeof rawText === "string" ? rawText : ""}`.trim();
    const parsed = parseComment(body);
    if (parsed === null) return { kind: "plain_comment", source, comment_id, author: who, body };
    if (parsed.kind === "unknown") return { kind: "unknown_command", source, comment_id, requester: who, command: parsed.word };
    const text = parsed.text;
    switch (parsed.name) {
      case "approve":
        return { kind: "spec_approved", source, comment_id, approver: who, note: text };
      case "reject":
        return { kind: "spec_rejected", source, comment_id, approver: who, reason: text };
      case "revise":
        return { kind: "revise_requested", source, comment_id, requester: who, feedback: text };
      case "retry":
        return { kind: "retry_requested", source, comment_id, requester: who };
      case "budget": {
        const amount = (text.split(/\r?\n/)[0] ?? "").trim();
        return { kind: "budget_continue", source, comment_id, approver: who, amount: amount === "" ? null : amount };
      }
      case "resolve":
        return { kind: "resolve_requested", source, comment_id, requester: who, notes: text, pr: null };
      case "help":
        return { kind: "help_requested", source, comment_id, requester: who };
      case "verdict":
        return { kind: "verdict_submitted", target: { kind: "issue", source }, comment_id, approver: who, args: text };
      default:
        return null;
    }
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const item = await this.store.getWorkItemBySource("local", source.id);
    if (!item) throw new Error(`local source: no work item for source id ${source.id}`);
    await this.store.recordItemMessage({ work_item_id: item.id, marker, body });
    return { url: null };
  }

  /** Nothing to mark: the command log has no reactions. */
  async markSeen(_source: SourceRef, _commentId: string | null): Promise<void> {}

  /** The store holds the item's status; there is no other surface to show it on. */
  async setStatus(_source: SourceRef, _status: WorkStatus, _pr_number: number | null): Promise<void> {}

  /** The store holds the item's state, so there is nothing else to close. */
  async closeIssue(_source: SourceRef, _reason?: SourceCloseReason): Promise<void> {}
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || cursor.trim() === "") return 0;
  const n = Number(cursor);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`local source: bad cursor ${JSON.stringify(cursor)}`);
  return n;
}
