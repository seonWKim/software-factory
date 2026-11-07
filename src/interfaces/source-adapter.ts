import type { WorkStatus } from "../core/status-label.js";
import type { SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// Intake surface. Two kinds of source: polled (GitHub issues) and streamed (pushed events, e.g. Slack).

/**
 * Command events carry `comment_id`, the id of the comment that held the command, so the controller can
 * react to it (`markSeen`) and key a refusal reply on it. `item_requested` is identified by `source.id`.
 */
export type SourceEvent =
  /**
   * An open source item, delivered when it is new and again after each edit (GitHub: the open-issue list since the
   * cursor). `updated_at`: when the source item last changed, ISO time; the controller re-reads its dependency
   * links only when it moved past the time they were read at (issue #254). Absent when the source gives none.
   */
  | { kind: "item_requested"; source: SourceRef; requester: ExternalIdentity; title: string; body: string; updated_at?: string }
  /**
   * `/approve [notes]`. `note` is the trimmed text after the command (same line and following lines), possibly
   * empty; untrusted. The controller splits a leading `+paths <path>...` line off it (parseCommandPaths), then
   * caps and egress-scans the rest before storing it. Absent means no note.
   */
  | { kind: "spec_approved"; source: SourceRef; comment_id: string; approver: ExternalIdentity; note?: string }
  /** `reason` is the text after `/reject`, possibly empty. */
  | { kind: "spec_rejected"; source: SourceRef; comment_id: string; approver: ExternalIdentity; reason: string }
  /**
   * `/revise <feedback>`: `feedback` is the text after the command, possibly empty (the controller refuses that).
   * On a PR's conversation, `pr` names that PR (any head branch: factory or adopted) and `source` is the PR
   * itself, so the 👀 and any reply go there; the controller finds the work item by the head branch, or an
   * adopted item by the PR number. On an issue, `pr` is null or absent.
   */
  | {
      kind: "revise_requested";
      source: SourceRef;
      comment_id: string;
      requester: ExternalIdentity;
      feedback: string;
      pr?: { pr_number: number; head_branch: string } | null;
    }
  /**
   * `/retry [notes]`. `note`: the trimmed text after the command, as for `spec_approved` (a leading `+paths`
   * line included); untrusted. Absent or empty means no note.
   */
  | { kind: "retry_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity; note?: string }
  /** `/help`: the controller replies once with every command, marking the ones that apply now. */
  | { kind: "help_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity }
  /**
   * `/standing [accept|decline <rule>]` (design 05-standing-approvals): `args` is the raw text after the command;
   * the controller parses it. About the factory's rules, answered on the work item the comment is on.
   */
  | { kind: "standing_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity; args: string }
  /** A command word the factory does not know, as typed (letters only, without the `/`). */
  | { kind: "unknown_command"; source: SourceRef; comment_id: string; requester: ExternalIdentity; command: string }
  /**
   * A comment by a person (not a bot) that is not a command. `body` is the whole comment, untrusted. The
   * controller may answer it once with a suggested command (design §4); nothing it does changes state.
   */
  | { kind: "plain_comment"; source: SourceRef; comment_id: string; author: ExternalIdentity; body: string }
  /**
   * The source item itself was closed (GitHub: a factory-labelled issue). `closer` is who closed it, null
   * when the source does not say. `state_reason` is how it was closed (GitHub's `state_reason`):
   * `completed`, `not_planned`, or null when the source gives none or one the factory does not know. May
   * be delivered again (same close, later poll); handling is idempotent. The controller handles it after the
   * forge's PR events of the same tick, so a merge that closed the issue is seen first.
   */
  | { kind: "source_closed"; source: SourceRef; closer: ExternalIdentity | null; state_reason: SourceCloseReason | null }
  /**
   * `/budget [tokens]` at a budget checkpoint (design §6). `amount` is the raw text after `/budget` on the
   * first line, null when there is none; the controller checks it is a whole number.
   */
  | { kind: "budget_continue"; source: SourceRef; comment_id: string; approver: ExternalIdentity; amount: string | null }
  /**
   * `/resolve [notes]` (design §5 Merge conflict). `notes`: the rest of the comment, trimmed; untrusted text.
   * On a factory PR's conversation, `pr` names that PR and `source` is the PR itself, so the 👀 and any reply
   * go there; the controller finds the work item by the head branch. On an issue, `pr` is null.
   */
  | {
      kind: "resolve_requested";
      source: SourceRef;
      comment_id: string;
      requester: ExternalIdentity;
      notes: string;
      pr: { pr_number: number; head_branch: string } | null;
    }
  /**
   * A `/verdict` comment on an issue or on a PR. `args` is the raw text after `/verdict` (following lines
   * included); the controller parses it. A PR target names the head branch, which maps to the work item.
   */
  | { kind: "verdict_submitted"; target: VerdictEventTarget; comment_id: string; approver: ExternalIdentity; args: string }
  /**
   * A commit that landed on the base branch, with its full message. The controller matches reverts of
   * factory merges in it (design §6). A boundary commit may be delivered again; handling is idempotent.
   */
  | { kind: "base_commit"; sha: string; message: string };

/** How a person closed a source item: done, or not going to be done. */
export type SourceCloseReason = "completed" | "not_planned";

/** What `fileSubIssue` needs: one phase of a split spec (design 2026-11-01). */
export interface SubIssueInput {
  /** The split parent's source item. */
  parent: SourceRef;
  title: string;
  /** The issue text; the source appends `marker`. Control-plane text built from the approved spec. */
  body: string;
  /** Unique per (parent, phase). Filing again finds the issue that carries it instead of filing another. */
  marker: string;
}

export type VerdictEventTarget =
  | { kind: "issue"; source: SourceRef }
  | { kind: "pr"; pr_number: number; head_branch: string };

export interface PollResult {
  events: SourceEvent[];
  /** Opaque; stored via FactoryStore.advanceCursor. */
  next_cursor: string;
}

/**
 * One event a stream source delivered. The listener saves it to the store inbox and, only after that write
 * commits, calls `ack()`. An event that is never acked must be delivered again by the source (e.g. Slack
 * Socket Mode redelivers unacked envelopes), so a crash between delivery and the write loses nothing.
 */
export interface PushedEvent {
  event: SourceEvent;
  /** Unique within the source: the same delivery (or a redelivery of it) always carries the same key. */
  dedupe_key: string;
  /** Tells the source the event is stored. Called at most once, and only after the inbox write committed. */
  ack(): Promise<void>;
}

/** What every source offers, whichever way its events arrive. */
interface SourceAdapterBase {
  readonly type: SourceType;
  /**
   * True when a refused intake (the requester may not submit work) gets no reply: GitHub, whose intake label is
   * the gate. Absent: the source replies once in the thread, so the person who asked knows why (a chat source).
   */
  readonly silent_intake_refusal?: true;
  /**
   * Control-plane messages (e.g. the spec, "merge requested"). Idempotent: a comment carrying `marker`
   * is posted at most once. Returns the comment's URL, both when it posts it and when a comment with the
   * marker already exists (null if the source has no link for it). Agents never call this.
   */
  postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }>;
  /**
   * Marks an event as seen (GitHub: a 👀 reaction). `commentId` null means the item itself (the issue).
   * Idempotent. Failures are the caller's to log; they must not block a transition.
   */
  markSeen(source: SourceRef, commentId: string | null): Promise<void>;
  /**
   * Shows the work item's status on the source (GitHub: one status label). `pr_number` null means the item
   * itself (the issue); non-null means the item's PR: PR status goes to the forge when one is selected
   * (`Forge.setPrStatus`, which may call this to write the label); the source does not route it. Afterwards the target carries exactly one of the factory's status markers; markers the
   * factory does not own are left alone. Idempotent: the same call twice changes nothing. Best effort:
   * failures are the caller's to log and must not block a transition. Sources with no such surface may
   * do nothing.
   */
  setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void>;
  /**
   * Closes the item on the source, as "not planned" by default (GitHub: the issue, `state_reason`). Used with
   * `not_planned` when a human rejects the spec, and with `completed` when every phase of a split closed as
   * completed (design 2026-11-01). Idempotent: closing a closed item changes nothing. Agents never call this.
   */
  closeIssue(source: SourceRef, reason?: SourceCloseReason): Promise<void>;
  /**
   * Files one phase of a split spec as a new item carrying the intake label, linked to `input.parent` as a
   * sub-issue (GitHub: the sub-issues API), and returns its ref. Idempotent: an item already carrying
   * `input.marker` is returned (and linked if it is not yet), never filed twice. Throws on a source failure;
   * the caller retries. Agents never call this. Absent on sources that cannot file items.
   */
  fileSubIssue?(input: SubIssueInput): Promise<SourceRef>;
  /**
   * True while the source's request budget is low (GitHub: under 10% or `min_remaining` of the hourly limit left,
   * until the reset): the controller skips its optional reads (dependency state refreshes, status catch-up) until
   * it is false again. Read-only, no request. Absent on sources without a budget.
   */
  lowBudget?(): boolean;
}

/** A source the controller polls on a timer (GitHub issues). */
export interface PollSource extends SourceAdapterBase {
  readonly intake: "poll";
  /**
   * Never delivers the same command comment twice across polls that advanced the cursor: an implementation
   * keeps whatever it needs (e.g. a comment-id high-water mark) in the cursor. Edits to an already
   * delivered comment are not delivered again.
   */
  poll(cursor: string | null): Promise<PollResult>;
}

/**
 * A source that pushes events as they happen (e.g. Slack Socket Mode). Only the replica holding the
 * source's listener lease subscribes (docs/architecture.md, Intake). The controller reads the events back
 * from the store inbox, never from the stream.
 */
export interface StreamSource extends SourceAdapterBase {
  readonly intake: "stream";
  /**
   * Opens one connection and yields its events until the connection ends (the iterable completes) or fails
   * (it throws). Must stop and complete once `signal` aborts. The listener reconnects by calling it again;
   * events delivered but not acked on a dead connection must come back on a later one.
   */
  subscribe(signal: AbortSignal): AsyncIterable<PushedEvent>;
}

/** A source is either polled or streamed; `intake` says which. */
export type SourceAdapter = PollSource | StreamSource;

