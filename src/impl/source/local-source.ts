import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef } from "../../core/types.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { PollResult, PollSource, SourceCloseReason } from "../../interfaces/source-adapter.js";

/**
 * The `local` poll source (issues #199, #282): a local item's surface is the store itself. The controller reads
 * the command inbox (`command_inbox`) on its own and writes every message to the item thread (`item_thread`), so
 * `poll` gives no events and leaves the cursor where it was, and `postComment` only makes sure the message is in
 * the thread (the controller never calls it for a local item). It never writes a command or creates an item, and
 * makes no network call.
 */
export class LocalSource implements PollSource {
  readonly intake = "poll";
  readonly type = "local";

  constructor(private readonly store: FactoryStore) {}

  /** Nothing to poll: the controller reads the command inbox itself. */
  async poll(cursor: string | null): Promise<PollResult> {
    return { events: [], next_cursor: cursor ?? "" };
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
}
