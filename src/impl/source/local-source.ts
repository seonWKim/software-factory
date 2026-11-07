import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef } from "../../core/types.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { PollResult, PollSource, SourceCloseReason, SubIssueInput } from "../../interfaces/source-adapter.js";

/**
 * The `local` poll source (issues #199, #282): a local item's surface is the store itself. The controller reads
 * the command inbox (`command_inbox`) on its own and writes every message to the item thread (`item_thread`), so
 * `poll` gives no events and leaves the cursor where it was. It never writes a command or creates an item, and
 * makes no network call.
 *
 * `fileSubIssue` (split specs, design 04) files nothing anywhere: a phase's ref is derived from the parent's
 * source id and the phase number in the marker (`<parent>-phase-<n>`), so the controller's work item, keyed on
 * that source, is the sub-task, and filing again returns the same ref.
 */
export class LocalSource implements PollSource {
  readonly intake = "poll";
  readonly type = "local";

  constructor(private readonly store: FactoryStore) {}

  /** Nothing to poll: the controller reads the command inbox itself. */
  async poll(cursor: string | null): Promise<PollResult> {
    return { events: [], next_cursor: cursor ?? "" };
  }

  /**
   * Kept because every SourceAdapter must have it: the controller gives a local item's messages no outbox row, so
   * it never calls this for a local item. Called anyway (another caller of the adapter contract), it keeps the
   * contract's promise: the message is in the item's thread once per marker, and an unknown id throws.
   */
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

  /** The phase's local ref, derived from `input` alone: no store read, no network call, the same ref every time. */
  async fileSubIssue(input: SubIssueInput): Promise<SourceRef> {
    if (input.parent.type !== "local") throw new Error(`local source: ${JSON.stringify(input.parent.id)} is not a local item`);
    const n = /:(\d+) -->$/.exec(input.marker)?.[1];
    if (!n) throw new Error(`local source: no phase number in marker ${JSON.stringify(input.marker)}`);
    const id = `${input.parent.id}-phase-${n}`;
    return { type: "local", id, link: `local:${id}` };
  }
}
