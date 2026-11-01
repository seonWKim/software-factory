import type { WorkStatus } from "../core/status-label.js";
import type { SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// Intake surface. Two kinds of source: polled (GitHub issues) and streamed (pushed events, e.g. Slack).

/**
 * Command events carry `comment_id`, the id of the comment that held the command, so the controller can
 * react to it (`markSeen`) and key a refusal reply on it. `item_requested` is identified by `source.id`.
 */
export type SourceEvent =
  | { kind: "item_requested"; source: SourceRef; requester: ExternalIdentity; title: string; body: string }
  /**
   * `/approve [notes]`. `note` is the trimmed text after the command (same line and following lines), possibly
   * empty; untrusted. The controller caps and egress-scans it before storing it. Absent means no note.
   */
  | { kind: "spec_approved"; source: SourceRef; comment_id: string; approver: ExternalIdentity; note?: string }
  /** `reason` is the text after `/reject`, possibly empty. */
  | { kind: "spec_rejected"; source: SourceRef; comment_id: string; approver: ExternalIdentity; reason: string }
  /** `/revise <feedback>`: `feedback` is the text after the command, possibly empty (the controller refuses that). */
  | { kind: "revise_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity; feedback: string }
  | { kind: "retry_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity }
  /** `/help`: the controller replies once with every command, marking the ones that apply now. */
  | { kind: "help_requested"; source: SourceRef; comment_id: string; requester: ExternalIdentity }
  /** A command word the factory does not know, as typed (letters only, without the `/`). */
  | { kind: "unknown_command"; source: SourceRef; comment_id: string; requester: ExternalIdentity; command: string }
  /**
   * A comment by a person (not a bot) that is not a command. `body` is the whole comment, untrusted. The
   * controller may answer it once with a suggested command (design §4); nothing it does changes state.
   */
  | { kind: "plain_comment"; source: SourceRef; comment_id: string; author: ExternalIdentity; body: string }
  /**
   * The source item itself was closed (GitHub: a factory-labelled issue). `closer` is who closed it, null
   * when the source does not say. May be delivered again (same close, later poll); handling is idempotent.
   * Delivered after any PR events of the same poll, so a merge that closed the issue is seen first.
   */
  | { kind: "source_closed"; source: SourceRef; closer: ExternalIdentity | null }
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
   * PR events name the head branch; the controller maps a factory branch back to a work item, and any other PR
   * to its adopted item by number. Every merged or closed PR is reported, not only factory ones (design
   * 2026-11-01), so a merge with no item is recorded as an unreviewed merge. `fork`: present and true when the
   * head is in another repository; such a PR is never a factory or adopted PR.
   */
  | { kind: "pr_merged"; pr_number: number; head_branch: string; merge_sha: string; merger: ExternalIdentity | null; fork?: true }
  | { kind: "pr_closed"; pr_number: number; head_branch: string; fork?: true }
  /**
   * An open PR against the base branch, from this repository (no forks), delivered on every poll while it is
   * open (design 2026-11-01): every factory-branch PR, and every other PR that is not a draft. `source` is the
   * PR itself (its comments and status label go there). The controller adopts a PR it does not know, and
   * compares `head_sha` with the head it recorded for one it does. `title`, `body` and `author` are
   * untrusted; `author` is null when the forge does not name one.
   */
  | {
      kind: "pr_open";
      source: SourceRef;
      pr_number: number;
      head_branch: string;
      head_sha: string;
      title: string;
      body: string;
      author: ExternalIdentity | null;
      labels: string[];
    }
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

/**
 * The automated checks on a PR's head commit (GitHub: check runs). `pending` while any check has not
 * finished and none failed; `failed` as soon as one finished without success, with the names of the failed
 * ones (untrusted text: check names come from files in the repository); `passed` when every check passed,
 * and also when the head commit has no checks at all, so a repository without CI is not held forever.
 */
export type PrChecks = { state: "pending" } | { state: "passed" } | { state: "failed"; failed: string[] };

/** What every source offers, whichever way its events arrive. */
interface SourceAdapterBase {
  readonly type: SourceType;
  /**
   * The checks on PR `pr_number`'s current head commit, read before a reviewed PR is offered for a human
   * merge (design §5 CI gate). Read-only, safe to call any number of times. Absent on sources with no
   * PRs: the controller then treats the checks as passed.
   */
  prChecks?(pr_number: number): Promise<PrChecks>;
  /**
   * The paths PR `pr_number` changes (both sides of a rename), read once when the PR is adopted. Read-only.
   * Absent on sources with no PRs.
   */
  prFiles?(pr_number: number): Promise<string[]>;
  /**
   * Who last added label `label` to PR or issue `number` (GitHub: the issue timeline), or null when nobody
   * did or the forge does not say. Read-only.
   */
  labelAddedBy?(number: number, label: string): Promise<ExternalIdentity | null>;
  /**
   * The forge account that authored commit `sha`, or null when it is not linked to one. The forge does not
   * name who pushed a commit; its author is the closest record (design 2026-11-01). Read-only.
   */
  commitAuthor?(sha: string): Promise<ExternalIdentity | null>;
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
   * itself (the issue); non-null means label that PR instead of the issue, so a caller that wants both
   * calls twice. Afterwards the target carries exactly one of the factory's status markers; markers the
   * factory does not own are left alone. Idempotent: the same call twice changes nothing. Best effort:
   * failures are the caller's to log and must not block a transition. Sources with no such surface may
   * do nothing.
   */
  setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void>;
  /**
   * Closes the item on the source as "not planned" (GitHub: the issue, `state_reason: not_planned`). Used
   * when a human rejects the spec. Idempotent: closing a closed item changes nothing. Agents never call this.
   */
  closeIssue(source: SourceRef): Promise<void>;
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

