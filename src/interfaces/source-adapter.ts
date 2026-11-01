import type { WorkStatus } from "../core/status-label.js";
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
  /**
   * `/budget [tokens]` at a budget checkpoint (design §6). `amount` is the raw text after `/budget` on the
   * first line, null when there is none; the controller checks it is a whole number.
   */
  | { kind: "budget_continue"; source: SourceRef; comment_id: string; approver: ExternalIdentity; amount: string | null }
  /**
   * A `/verdict` comment on an issue or on a PR. `args` is the raw text after `/verdict` (following lines
   * included); the controller parses it. A PR target names the head branch, which maps to the work item.
   */
  | { kind: "verdict_submitted"; target: VerdictEventTarget; comment_id: string; approver: ExternalIdentity; args: string }
  /** PR events name the head branch; the controller maps it back to a work item. */
  | { kind: "pr_merged"; pr_number: number; head_branch: string; merge_sha: string; merger: ExternalIdentity | null }
  | { kind: "pr_closed"; pr_number: number; head_branch: string }
  /**
   * An open factory PR the forge reports as not mergeable into its base (GitHub: `mergeable === false`).
   * Delivered on every poll while it stays so; the shas let the controller key one update per (head, base).
   */
  | { kind: "pr_unmergeable"; pr_number: number; head_branch: string; head_sha: string; base_sha: string }
  /**
   * A commit that landed on the base branch, with its full message. The controller matches reverts of
   * factory merges in it (design §6). A boundary commit may be delivered again; handling is idempotent.
   */
  | { kind: "base_commit"; sha: string; message: string };

export type VerdictEventTarget =
  | { kind: "issue"; source: SourceRef }
  | { kind: "pr"; pr_number: number; head_branch: string };

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
  /**
   * Shows the work item's status on the source (GitHub: one status label). `pr_number` null means the item
   * itself (the issue); non-null means label that PR instead of the issue, so a caller that wants both
   * calls twice. Afterwards the target carries exactly one of the factory's status markers; markers the
   * factory does not own are left alone. Idempotent: the same call twice changes nothing. Best effort:
   * failures are the caller's to log and must not block a transition. Sources with no such surface may
   * do nothing.
   */
  setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void>;
}
