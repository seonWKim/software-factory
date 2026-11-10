import type { ProjectRef } from "../core/project.js";
import type { WorkStatus } from "../core/status-label.js";
import type { PrCheckResult, SourceRef, SourceType } from "../core/types.js";
import type { ExternalIdentity } from "./auth-provider.js";

// The forge: where changes live (one implementation today). Optional: config may select none (plugins.forge). Since
// issue #273 the controller reads every PR event and PR fact from it, and posts every PR comment and PR status
// through it; the sources bring issues and their comments only (docs/plugins/forge.md).

/**
 * The PR events a forge reports. Each names the head branch; the controller maps a factory branch back to a work
 * item, and any other PR to its adopted item by its `change_ref`: the PR number as text, the same type the store
 * keeps (design 02). The controller converts it with prNumber (src/core/change-ref.ts) only for a forge call.
 */
export type ForgeEvent =
  /**
   * Every merged or closed PR is reported, not only factory ones (design 2026-11-01), so a merge with no item is
   * recorded as an unreviewed merge. `fork`: present and true when the head is in another repository; such a PR is
   * never a factory or adopted PR.
   */
  | { kind: "change_merged"; change_ref: string; head_branch: string; merge_sha: string; merger: ExternalIdentity | null; fork?: true }
  | { kind: "change_closed"; change_ref: string; head_branch: string; fork?: true }
  /**
   * An open PR against the base branch, from this repository (no forks), delivered on every poll while it is
   * open (design 2026-11-01): every factory-branch PR, and every other PR that is not a draft. `source` is the
   * PR itself (its comments and status label go there). The controller adopts a PR it does not know, and
   * compares `head_sha` with the head it recorded for one it does. `title`, `body` and `author` are
   * untrusted; `author` is null when the forge does not name one.
   */
  | {
      kind: "change_open";
      source: SourceRef;
      change_ref: string;
      head_branch: string;
      head_sha: string;
      title: string;
      body: string;
      author: ExternalIdentity | null;
      labels: string[];
    }
  /**
   * An open factory PR the forge reports as not mergeable into its base (e.g. `mergeable === false`).
   * Delivered on every poll while it stays so; the shas let the controller key one update per (head, base).
   */
  | { kind: "change_unmergeable"; change_ref: string; head_branch: string; head_sha: string; base_sha: string }
  /**
   * A "Request changes" review on an open PR (design §4), by a person (never a bot). `source` is the PR,
   * `review_id` the forge's review id, delivered at most once per review by a poll that advanced the cursor;
   * the controller still refuses a review it already applied. `body` and each line comment's `body` are
   * untrusted; `line` is null when the forge gives none (a comment on a whole file or an outdated line).
   */
  | {
      kind: "pr_changes_requested";
      source: SourceRef;
      change_ref: string;
      head_branch: string;
      review_id: string;
      reviewer: ExternalIdentity;
      body: string;
      comments: PrLineComment[];
    };

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
 * The automated checks on a PR's head commit (e.g. check runs). `pending` while any check has not
 * finished and none failed; `failed` as soon as one finished without success, with the names of the failed
 * ones (untrusted text: check names come from files in the repository); `passed` when every check passed,
 * and also when the head commit has no checks at all, so a repository without CI is not held forever.
 */
export type PrChecks = { state: "pending" } | { state: "passed" } | { state: "failed"; failed: string[] };

/** What `closePr` needs. */
export interface ClosePrInput {
  pr: number;
  /** The source item that was closed; the forge reads who closed it when it can. */
  closed: SourceRef;
  /** The comment is posted at most once per marker, like postPrComment. */
  marker: string;
  /** The comment text, given who closed `closed` (null when the forge does not say). */
  body(closer: ExternalIdentity | null): string;
}

/** How `mergePr` merges: a merge commit (what the factory asks for, as the local merge does), a squash, or a rebase. */
export type PrMergeMethod = "merge" | "squash" | "rebase";

/**
 * `merged`: the PR is merged, its merge commit `sha` (`already`: it was merged before this call, so nothing new was
 * merged). `refused`: the forge refused the merge and nothing moved, with why in plain words (no forge text).
 */
export type PrMergeResult = { merged: true; sha: string; already: boolean } | { merged: false; refused: string };

/** What `pushBase` needs: the factory repo, its base branch, the commit to push, and the remote base it read. */
export interface BasePushInput {
  /** The factory repo's path: its `origin` is where the base goes. */
  repo: string;
  base_ref: string;
  /** The local base to push: a descendant of `expected_sha`. */
  sha: string;
  /** The remote base the factory read before this push: the push applies only while the remote is still there. */
  expected_sha: string;
}

/** What `pushBranch` needs: the factory repo holding the commit, the factory branch, and the commit. */
export interface BranchPushInput {
  /** The factory repo's path: the run's last step wrote `sha` to a ref there; its `origin` is where it goes. */
  repo: string;
  branch: string;
  sha: string;
}

/** What `openPr` needs: the factory branch, its base, the PR text, and labels to add (true) or remove (false). */
export interface OpenPrInput {
  branch: string;
  base_ref: string;
  title: string;
  body: string;
  labels?: Readonly<Record<string, boolean>>;
}

/**
 * What a commit message or an item's text says about other changes (design §6), as this forge names changes. A
 * forge parses its own change-ref form; the shapes around it (the git revert body, a `Revert` subject, `Fixes` and
 * `Follow-up to`) are the same for every forge (src/core/links.ts).
 */
export interface ChangeLinks {
  /** Shas from `This reverts commit <sha>` anywhere in the message, lowercased. */
  reverted_shas: string[];
  /** Change refs a `Revert` subject names, minus the reverting one: candidate reverted changes. */
  reverted_refs: string[];
  /** The change that made this revert commit, when the forge marks it on the subject; else null. */
  reverting_ref: string | null;
  /** Change refs named by `Fixes <ref>` or `Follow-up to <ref>`, in order of first mention. */
  fix_refs: string[];
}

/** The prefix of the factory's status labels (`status_label_prefix` in factory.config.json) when config sets none. */
export const DEFAULT_STATUS_LABEL_PREFIX = "sf: ";

/** The PR events, facts and writes the factory reads from and makes on a forge. Agents never call it. */
export interface Forge {
  /** The source type of the PR refs this forge hands out (`prRef`): PR comments wait in the outbox under it. */
  readonly ref_type: SourceType;
  /**
   * The cursor this forge's position was kept under before it had its own (e.g. its issue source's
   * `intake:github_issue`), read once while the forge's own cursor is empty. Absent: none.
   */
  readonly handover_cursor?: string;
  /**
   * The configured repo as a project (design 08-plugins): its key from the forge's permanent repository ID and its
   * label from the path the forge reports now. Read once per startup (src/compose.ts, startupProject). Throws when
   * the forge cannot say; an error whose `permanent` is true (bad credentials, no such repository) is one retrying
   * cannot fix. Absent: this forge names no repository, and startup uses the local project key.
   */
  projectIdentity?(): Promise<ProjectRef>;
  /**
   * The PR events since `cursor` (null: the first poll), read on the poll interval. Never delivers the same review
   * twice across polls that advanced the cursor; other events may repeat, and handling them is idempotent.
   */
  poll(cursor: string | null): Promise<ForgePollResult>;
  /**
   * The revert and fix-forward links in `message` (a base-branch commit message, or an item's title and body), its
   * change refs in the form `change_ref` takes. Pure: no read, no write, no call. Each ref appears once.
   */
  parseLinks(message: string): ChangeLinks;
  /** PR `pr` as a comment target. */
  prRef(pr: number): SourceRef;
  /** The PR number `ref` names if it is one of this forge's PR refs (`prRef`), else null. */
  prNumberOf(ref: SourceRef): number | null;
  /**
   * One comment on PR `pr`. Idempotent: a comment carrying `marker` is posted at most once. Returns its URL,
   * both when it posts it and when one with the marker already exists (null if the forge has no link for it).
   */
  postPrComment(pr: number, body: string, marker: string): Promise<{ url: string | null }>;
  /**
   * Shows `status` on PR `pr` of the item from `source` (e.g. one status label on the PR). Afterwards the
   * PR carries exactly one of the factory's status markers; others are left alone. Idempotent and best effort:
   * failures are the caller's to log and must not block a transition.
   */
  setPrStatus(source: SourceRef, status: WorkStatus, pr: number): Promise<void>;
  /** The checks on PR `pr`'s current head commit (design §5 CI gate): `prCheckResults` summed up. Read-only. */
  prChecks(pr: number): Promise<PrChecks>;
  /**
   * Each check on PR `pr`'s current head commit with its result; empty when none ran. Read when a review is
   * queued, for the review prompt (design §4, issue #223). Throws when the forge cannot be read. Read-only.
   */
  prCheckResults(pr: number): Promise<PrCheckResult[]>;
  /** The paths PR `pr` changes (both sides of a rename), read once when the PR is adopted. Read-only. */
  prFiles(pr: number): Promise<string[]>;
  /** Who last added label `label` to PR `pr`, or null when nobody did or the forge does not say. Read-only. */
  labelAddedBy(pr: number, label: string): Promise<ExternalIdentity | null>;
  /**
   * The forge account that authored commit `sha`, or null when it is not linked to one. The forge does not name who
   * pushed a commit; its author is the closest record (design 2026-11-01). Read-only.
   */
  commitAuthor(sha: string): Promise<ExternalIdentity | null>;
  /**
   * How many commits `to_sha` has that `from_sha` does not (the commits in a push from `from_sha` to `to_sha`), or
   * null when the forge cannot say (e.g. `from_sha` is gone after a force-push). Read when a person's push to a
   * factory PR is recorded as an implicit `changes` verdict (design §4). Read-only.
   */
  commitsBetween(from_sha: string, to_sha: string): Promise<number | null>;
  /**
   * Closes factory PR `pr` without merging it, after one comment carrying `input.marker`. Used when a person
   * closes the source item (design §4). A PR that is already merged or closed is left alone with no comment:
   * `not_open`. The comment goes first, so a failed close retried later finds its comment and does not post
   * another. Throws on a forge failure; the caller retries.
   */
  closePr(input: ClosePrInput): Promise<"closed" | "not_open">;
  /**
   * Merges PR `pr` with `method`, only while its head is still `head_sha` (the head the review passed): the forge
   * itself refuses a head that moved. A PR that is already merged answers its merge commit with `already`, so a
   * retry after a merge the store did not record yet makes no second merge. Called only for a person's Merge
   * (design §9), never automatically. Throws on a forge failure other than a refusal; nothing moved then either.
   */
  mergePr(pr: number, head_sha: string, method: PrMergeMethod): Promise<PrMergeResult>;
  /**
   * The base push (design 05-sources, Local items): moves the remote base branch to `input.sha`, only while it is
   * still at `input.expected_sha`, so a base that moved again is never overwritten. Never a hook. Throws on any
   * failure (an outage, a rate limit, a refused credential, a base that moved): the caller retries with backoff.
   * Absent: this forge cannot push a base, and a local merge queues none.
   */
  pushBase?(input: BasePushInput): Promise<void>;
  /**
   * A run's push (RFC 0015 M7): moves the remote factory branch to `input.sha` from the factory repo, never forced.
   * Reconciles first: a remote branch already at the sha is `already`, with no push. Throws on any failure (an
   * outage, a rate limit, a refused credential, a rejected push), its message starting with the failure class;
   * outbound retries with backoff. Absent: this forge cannot push.
   */
  pushBranch?(input: BranchPushInput): Promise<"pushed" | "already">;
  /**
   * Opens the factory branch's PR, or updates the open one's title and body (reconcile: an open PR for the branch
   * is updated, never a second one opened), then sets its labels. Returns its number and link. Throws on a failure.
   */
  openPr?(input: OpenPrInput): Promise<{ number: number; url: string | null }>;
}
