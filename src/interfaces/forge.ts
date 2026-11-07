import type { WorkStatus } from "../core/status-label.js";
import type { SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// The forge: where pull requests live (GitHub today). Optional: config may select none (plugins.forge). Since
// issue #273 the controller reads every PR event and PR fact from it, and posts every PR comment and PR status
// through it; the sources bring issues and their comments only (docs/plugins/forge.md).

/**
 * The PR events a forge reports. Each names the head branch; the controller maps a factory branch back to a work
 * item, and any other PR to its adopted item by number.
 */
export type ForgeEvent =
  /**
   * Every merged or closed PR is reported, not only factory ones (design 2026-11-01), so a merge with no item is
   * recorded as an unreviewed merge. `fork`: present and true when the head is in another repository; such a PR is
   * never a factory or adopted PR.
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
   * A "Request changes" review on an open PR (design §4), by a person (never a bot). `source` is the PR,
   * `review_id` the forge's review id, delivered at most once per review by a poll that advanced the cursor;
   * the controller still refuses a review it already applied. `body` and each line comment's `body` are
   * untrusted; `line` is null when the forge gives none (a comment on a whole file or an outdated line).
   */
  | {
      kind: "pr_changes_requested";
      source: SourceRef;
      pr_number: number;
      head_branch: string;
      review_id: string;
      reviewer: ExternalIdentity;
      body: string;
      comments: PrLineComment[];
    };

export type ForgeEventKind = ForgeEvent["kind"];

/** One line comment of a PR review: the file, the line in the PR's version of it, and the text. */
export interface PrLineComment {
  path: string;
  line: number | null;
  body: string;
}

export interface ForgePollResult {
  events: ForgeEvent[];
  /** Opaque; stored via FactoryStore.advanceCursor. */
  next_cursor: string;
}

/**
 * The automated checks on a PR's head commit (GitHub: check runs). `pending` while any check has not
 * finished and none failed; `failed` as soon as one finished without success, with the names of the failed
 * ones (untrusted text: check names come from files in the repository); `passed` when every check passed,
 * and also when the head commit has no checks at all, so a repository without CI is not held forever.
 */
export type PrChecks = { state: "pending" } | { state: "passed" } | { state: "failed"; failed: string[] };

/** What `closePr` needs. */
export interface ClosePrInput {
  pr_number: number;
  /** The source item that was closed; the forge reads who closed it when it can. */
  closed: SourceRef;
  /** The comment is posted at most once per marker, like postPrComment. */
  marker: string;
  /** The comment text, given who closed `closed` (null when the forge does not say). */
  body(closer: ExternalIdentity | null): string;
}

/**
 * What the merge command re-reads before it merges (design §4, merge command): the PR's state, its current head,
 * whether it merges cleanly into its base (null while the forge is still working that out), the merge commit once
 * merged, and its size (added plus deleted lines, changed files; null when the forge does not say).
 */
export interface PrMergeState {
  state: "open" | "merged" | "closed";
  head_sha: string | null;
  mergeable: boolean | null;
  merge_sha: string | null;
  lines: number | null;
  files: number | null;
}

/**
 * What `mergePr` needs: the PR, its branch and base, and the head that was reviewed (the merge refuses any other).
 * No text from the item goes along: the merge commit gets the forge's own subject.
 */
export interface MergePrInput {
  pr_number: number;
  branch: string;
  base_ref: string;
  head_sha: string;
}

/** A merge the forge made, or why it refused one (fixed words, never forge text). */
export type MergePrResult = { merged: true; merge_sha: string } | { merged: false; reason: string };

/** The PR events, facts and writes the factory reads from and makes on a forge. Agents never call it. */
export interface Forge {
  /** The source type of the PR refs this forge hands out (`prRef`): PR comments wait in the outbox under it. */
  readonly ref_type: SourceType;
  /**
   * The cursor this forge's position was kept under before it had its own (GitHub: the GitHub source's
   * `intake:github_issue`), read once while the forge's own cursor is empty. Absent: none.
   */
  readonly handover_cursor?: string;
  /**
   * The PR events since `cursor` (null: the first poll), read on the poll interval. Never delivers the same review
   * twice across polls that advanced the cursor; other events may repeat, and handling them is idempotent.
   */
  poll(cursor: string | null): Promise<ForgePollResult>;
  /** PR `pr_number` as a comment target. */
  prRef(pr_number: number): SourceRef;
  /** The PR number `ref` names if it is one of this forge's PR refs (`prRef`), else null. */
  prNumberOf(ref: SourceRef): number | null;
  /**
   * One comment on PR `pr_number`. Idempotent: a comment carrying `marker` is posted at most once. Returns its URL,
   * both when it posts it and when one with the marker already exists (null if the forge has no link for it).
   */
  postPrComment(pr_number: number, body: string, marker: string): Promise<{ url: string | null }>;
  /**
   * Shows `status` on PR `pr_number` of the item from `source` (GitHub: one status label on the PR). Afterwards the
   * PR carries exactly one of the factory's status markers; others are left alone. Idempotent and best effort:
   * failures are the caller's to log and must not block a transition.
   */
  setPrStatus(source: SourceRef, status: WorkStatus, pr_number: number): Promise<void>;
  /** The checks on PR `pr_number`'s current head commit (design §5 CI gate). Read-only. */
  prChecks(pr_number: number): Promise<PrChecks>;
  /** The paths PR `pr_number` changes (both sides of a rename), read once when the PR is adopted. Read-only. */
  prFiles(pr_number: number): Promise<string[]>;
  /** Who last added label `label` to PR `pr_number`, or null when nobody did or the forge does not say. Read-only. */
  labelAddedBy(pr_number: number, label: string): Promise<ExternalIdentity | null>;
  /**
   * The forge account that authored commit `sha`, or null when it is not linked to one. The forge does not name who
   * pushed a commit; its author is the closest record (design 2026-11-01). Read-only.
   */
  commitAuthor(sha: string): Promise<ExternalIdentity | null>;
  /**
   * Closes factory PR `pr_number` without merging it, after one comment carrying `input.marker`. Used when a person
   * closes the source item (design §4). A PR that is already merged or closed is left alone with no comment:
   * `not_open`. The comment goes first, so a failed close retried later finds its comment and does not post
   * another. Throws on a forge failure; the caller retries.
   */
  closePr(input: ClosePrInput): Promise<"closed" | "not_open">;
  /** PR `pr_number` (head branch `branch`) as the merge command re-checks it. Read-only. */
  prMergeState(pr_number: number, branch: string): Promise<PrMergeState>;
  /**
   * Merges PR `input.pr_number` into its base, only while its head is still `input.head_sha` (design §4, merge
   * command). Called by the controller after its re-checks, never by an agent. A refusal changes nothing.
   */
  mergePr(input: MergePrInput): Promise<MergePrResult>;
}
