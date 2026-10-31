import type { SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// Intake surface. First impl: GitHub issues on this repo (poll). Webhooks and Slack later.

/**
 * Command events carry `comment_id`, the id of the comment that held the command, so the controller can
 * react to it (`markSeen`) and key a refusal reply on it. `item_requested` is identified by `source.id`.
 */
export type SourceEvent =
  | { kind: "item_requested"; source: SourceRef; requester: ExternalIdentity; title: string; body: string }
  | { kind: "spec_approved"; source: SourceRef; comment_id: string; approver: ExternalIdentity }
  | { kind: "spec_rejected"; source: SourceRef; comment_id: string; approver: ExternalIdentity; reason: string }
  | { kind: "retry_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity }
  /** PR events name the head branch; the controller maps it back to a work item. Reverts: Phase 2. */
  | { kind: "pr_merged"; pr_number: number; head_branch: string; merge_sha: string; merger: ExternalIdentity | null }
  | { kind: "pr_closed"; pr_number: number; head_branch: string }
  /**
   * An open factory PR the forge reports as not mergeable into its base (GitHub: `mergeable === false`).
   * Delivered on every poll while it stays so; the shas let the controller key one update per (head, base).
   */
  | { kind: "pr_unmergeable"; pr_number: number; head_branch: string; head_sha: string; base_sha: string };

export interface PollResult {
  events: SourceEvent[];
  /** Opaque; stored via FactoryStore.advanceCursor. */
  next_cursor: string;
}

export interface SourceAdapter {
  readonly type: SourceType;
  /**
   * Never delivers the same command comment twice across polls that advanced the cursor: an implementation
   * keeps whatever it needs (e.g. a comment-id high-water mark) in the cursor. Edits to an already
   * delivered comment are not delivered again.
   */
  poll(cursor: string | null): Promise<PollResult>;
  /**
   * Control-plane messages (e.g. the spec, "merge requested"). Idempotent: a comment carrying `marker`
   * is posted at most once. Agents never call this.
   */
  postComment(source: SourceRef, body: string, marker: string): Promise<void>;
  /**
   * Marks an event as seen (GitHub: a 👀 reaction). `commentId` null means the item itself (the issue).
   * Idempotent. Failures are the caller's to log; they must not block a transition.
   */
  markSeen(source: SourceRef, commentId: string | null): Promise<void>;
}
