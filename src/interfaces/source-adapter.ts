import type { SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// Intake surface. First impl: GitHub issues on this repo (poll). Webhooks and Slack later.

export type SourceEvent =
  | { kind: "item_requested"; source: SourceRef; requester: ExternalIdentity; title: string; body: string }
  | { kind: "spec_approved"; source: SourceRef; approver: ExternalIdentity }
  | { kind: "spec_rejected"; source: SourceRef; approver: ExternalIdentity; reason: string }
  | { kind: "retry_requested"; source: SourceRef; requester: ExternalIdentity }
  /** PR events name the head branch; the controller maps it back to a work item. Reverts: Phase 2. */
  | { kind: "pr_merged"; pr_number: number; head_branch: string; merge_sha: string }
  | { kind: "pr_closed"; pr_number: number; head_branch: string };

export interface PollResult {
  events: SourceEvent[];
  /** Opaque; stored via FactoryStore.advanceCursor. */
  next_cursor: string;
}

export interface SourceAdapter {
  readonly type: SourceType;
  poll(cursor: string | null): Promise<PollResult>;
  /**
   * Control-plane messages (e.g. the spec, "merge requested"). Idempotent: a comment carrying `marker`
   * is posted at most once. Agents never call this.
   */
  postComment(source: SourceRef, body: string, marker: string): Promise<void>;
}
