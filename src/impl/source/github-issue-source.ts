import { parseComment } from "../../core/commands.js";
import { type DependencyLink, type DependencySource, parseDependsOn } from "../../core/coordination.js";
import { incompleteLabel } from "../../core/pr-body.js";
import { WORK_STATUSES, type WorkStatus } from "../../core/status-label.js";
import type { DependencyState, SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import { type FactoryStore, labelTarget } from "../../interfaces/factory-store.js";
import type {
  ClosePrInput, PollResult, PollSource, PrChecks, PrLineComment, SourceCloseReason, SourceEvent, SubIssueInput, VerdictEventTarget,
} from "../../interfaces/source-adapter.js";
import { type GitHubClient, GitHubError, type RepoRef, issueNumberFromSourceId } from "../github/github-client.js";

interface GhUser {
  id: number;
  login: string;
  type: string;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  user: GhUser;
  updated_at: string;
  pull_request?: unknown;
}
/** An issue as the sub-issue calls need it: `id` (not the number) is what the sub-issues API takes. */
interface GhIssueRef {
  id: number;
  number: number;
  body?: string | null;
  pull_request?: unknown;
}
interface GhIssueFull extends GhIssue {
  /** Only on the single-issue endpoint. Null when GitHub does not know who closed it. */
  closed_by: GhUser | null;
  /** completed, not_planned, reopened, duplicate, ... ; null when GitHub has none. */
  state_reason?: string | null;
}
/** An issue as the sub-issue and dependency lists return it. */
interface GhLinkedIssue {
  number: number;
  /** `https://api.github.com/repos/<owner>/<name>`: the linked issue may live in another repository. */
  repository_url?: string;
  state?: string;
  state_reason?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}
interface GhComment {
  id: number;
  issue_url: string;
  /** `.../pull/<n>#issuecomment-<id>` for a comment on a PR's conversation, `.../issues/<n>#...` on an issue. */
  html_url?: string;
  body: string;
  user: GhUser;
  updated_at: string;
}
interface GhPull {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
  /** `repo` is null when the head repository was deleted (a fork that is gone). */
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string };
  draft?: boolean;
  title?: string;
  body?: string | null;
  user?: GhUser | null;
  labels?: { name: string }[];
}
/** A PR review. `state`: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
interface GhReview {
  id: number;
  state: string;
  body: string | null;
  user: GhUser | null;
  /** Absent on a pending review. */
  submitted_at?: string | null;
}
/** A line comment of a review. `line` is null on an outdated comment; `original_line` is where it was made. */
interface GhReviewComment {
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
}
interface GhPullFile {
  filename: string;
  previous_filename?: string;
}
interface GhTimelineEvent {
  event: string;
  label?: { name: string };
  actor?: GhUser | null;
}
interface GhPullFull extends GhPull {
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  merged_by: GhUser | null;
}
interface GhCheckRun {
  name: string;
  /** queued, in_progress, completed, waiting, requested, pending. */
  status: string;
  /** Set once completed: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, ... */
  conclusion: string | null;
}
interface GhStatus {
  context: string;
  /** error, failure, pending, success. */
  state: string;
}
interface GhCommit {
  sha: string;
  commit: { message: string; committer: { date: string } | null };
}

interface Cursor {
  issues: string | null;
  comments: string | null;
  pulls: string | null;
  /**
   * Highest comment id already read. `since` is inclusive and keyed on updated_at, so the last comment
   * (and any edit of an old one) comes back on the next poll; ids only grow, so anything at or below this
   * was already delivered. Absent in cursors written before it existed.
   */
  last_comment_id?: number | null;
  /**
   * Newest base-branch commit date already read, and the shas read at exactly that date. `since` is
   * inclusive, so those come back on the next poll and are skipped. Absent in cursors written before
   * commits were polled: that poll reads the newest 500 commits.
   */
  commits?: string | null;
  commit_shas?: string[];
  /**
   * Newest updated_at of a closed factory issue already read, and the issue numbers read at exactly that
   * time (`since` is inclusive; those are skipped unless updated again). Absent in cursors written before
   * closes were polled: that poll reads every closed factory issue.
   */
  closed?: string | null;
  closed_numbers?: number[];
  /**
   * Reviews (design §4): reviews submitted before this time are never delivered, and only open PRs updated at
   * or after it are read. `review_ids` are the reviews already read that were submitted at or after it. Absent
   * in cursors written before reviews were read, and on the first poll: that poll sets the time to the newest
   * open PR update and delivers no review, so a review from before the factory read reviews starts nothing.
   */
  reviews?: string | null;
  review_ids?: number[];
}

/**
 * The status labels: name suffix, colour and description. The one place they are defined; setup creates
 * them, doctor checks them, setStatus creates any that is missing. Names are the configured prefix + suffix.
 */
const STATUS_LABELS: Record<WorkStatus, { suffix: string; color: string; description: string }> = {
  triaging: { suffix: "triaging", color: "c5def5", description: "Factory: triage agent is writing the spec" },
  needs_approval: { suffix: "needs approval", color: "fbca04", description: "Factory: spec waits for /approve or /reject" },
  implementing: { suffix: "implementing", color: "1d76db", description: "Factory: implementer agent is working" },
  in_review: { suffix: "in review", color: "5319e7", description: "Factory: reviewer agent is checking the PR" },
  ready_to_merge: { suffix: "ready to merge", color: "0e8a16", description: "Factory: PR passed review; waits for a human merge" },
  needs_human: { suffix: "needs human", color: "d93f0b", description: "Factory: stuck (failed run, loop limit, conflict); see comments" },
  done: { suffix: "done", color: "cccccc", description: "Factory: PR merged" },
  rejected: { suffix: "rejected", color: "000000", description: "Factory: closed without a merge" },
};

export const DEFAULT_STATUS_LABEL_PREFIX = "sf: ";

export interface StatusLabel {
  status: WorkStatus;
  name: string;
  color: string;
  description: string;
}

/** The eight status labels under `prefix`, in WORK_STATUSES order. */
export function statusLabels(prefix: string): StatusLabel[] {
  return WORK_STATUSES.map((status) => {
    const { suffix, color, description } = STATUS_LABELS[status];
    return { status, name: `${prefix}${suffix}`, color, description };
  });
}

/**
 * Labels the worker sets on a PR beside its status (issue #229): `incomplete` while the implementer reports
 * missing work. Setup creates them and doctor checks them, like the status labels.
 */
export function prFlagLabels(prefix: string): { name: string; color: string; description: string }[] {
  return [{ name: incompleteLabel(prefix), color: "b60205", description: "Factory: the PR reports missing work; not done when merged" }];
}

/** Check-run pages read per prChecks call, 100 each. */
const CHECK_PAGES = 3;
/** Check-run conclusions that do not fail the gate. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** How long a label write's claim holds before another replica may take it over (design §5, GitHub call budget). */
const LABEL_CLAIM_MS = 60_000;
/** Pages of an issue's thread read to find a marker the store has no record of. */
const THREAD_PAGES = 10;
/** Backoff of a failing comment post: 1 s after the first failure, doubling, at most 5 min. */
const COMMENT_BACKOFF_BASE_MS = 1_000;
const COMMENT_BACKOFF_MAX_MS = 5 * 60_000;

/** The wait after failed post number `attempts` (1-based) before the next try. */
export function commentBackoffMs(attempts: number): number {
  return Math.min(COMMENT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), COMMENT_BACKOFF_MAX_MS);
}

/** Commit pages read per poll, 100 each, newest first. Older commits in the window are not read. */
const COMMIT_PAGES = 5;

export class GitHubIssueSource implements PollSource, DependencySource {
  readonly type = "github_issue" as const;
  readonly intake = "poll" as const;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: RepoRef,
    private readonly label: string,
    private readonly branchPrefix: string,
    private readonly baseBranch: string,
    private readonly statusPrefix: string = DEFAULT_STATUS_LABEL_PREFIX,
    /**
     * Where posted comments and written labels are recorded, shared by every replica (design §5, GitHub call
     * budget). Without one (the forge's own source) every post reads the thread and every status reads the labels.
     */
    private readonly store: FactoryStore | null = null,
  ) {}

  async poll(cursor: string | null): Promise<PollResult> {
    const c: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : { issues: null, comments: null, pulls: null };
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const events: SourceEvent[] = [];
    const next: Cursor = { ...c, last_comment_id: c.last_comment_id ?? null };

    const issues = await this.client.list<GhIssue>(
      `${base}/issues?state=open&labels=${encodeURIComponent(this.label)}&sort=updated&direction=asc` +
        (c.issues ? `&since=${c.issues}` : ""),
    );
    for (const i of issues) {
      next.issues = max(next.issues, i.updated_at);
      if (i.pull_request) continue;
      events.push({
        kind: "item_requested",
        source: this.ref(i.number),
        requester: identity(i.user),
        title: i.title,
        body: i.body ?? "",
      });
    }

    // Closed factory issues. Read before the pulls (a merge that closes its issue happens before the close, so
    // the pulls read below already sees it) but delivered after them, so pr_merged is applied first.
    const closes = await this.closedIssues(c, next);

    const comments = await this.client.list<GhComment>(
      `${base}/issues/comments?sort=updated&direction=asc` + (c.comments ? `&since=${c.comments}` : ""),
    );
    const seen = new Set<number>();
    for (const cm of comments) {
      next.comments = max(next.comments, cm.updated_at);
      // Compare with the previous poll's mark, not the running one: this page is ordered by updated_at, not id.
      if ((c.last_comment_id != null && cm.id <= c.last_comment_id) || seen.has(cm.id)) continue;
      seen.add(cm.id);
      next.last_comment_id = Math.max(next.last_comment_id ?? 0, cm.id);
      if (cm.user.type === "Bot") continue;
      const source = this.ref(Number(cm.issue_url.split("/").pop()));
      const comment_id = String(cm.id);
      const parsed = parseComment(cm.body);
      const who = identity(cm.user);
      if (parsed === null) {
        // Suggestions answer issue comments only; PR conversation comments are left alone (design §4).
        if (!cm.html_url?.includes("/pull/")) events.push({ kind: "plain_comment", source, comment_id, author: who, body: cm.body });
        continue;
      }
      if (parsed.kind === "unknown") {
        events.push({ kind: "unknown_command", source, comment_id, requester: who, command: parsed.word });
        continue;
      }
      const text = parsed.text;
      switch (parsed.name) {
        case "approve":
          events.push({ kind: "spec_approved", source, comment_id, approver: who, note: text });
          break;
        case "reject":
          events.push({ kind: "spec_rejected", source, comment_id, approver: who, reason: text });
          break;
        case "revise":
        {
          // On a PR's conversation: any PR of this repository (factory or adopted); one that is gone is ignored.
          if (cm.html_url?.includes("/pull/")) {
            const pr = await this.pullHead(base, Number(cm.issue_url.split("/").pop()));
            if (pr) events.push({ kind: "revise_requested", source, comment_id, requester: who, feedback: text, pr });
            break;
          }
          events.push({ kind: "revise_requested", source, comment_id, requester: who, feedback: text });
          break;
        }
        case "retry":
          events.push({ kind: "retry_requested", source, comment_id, requester: who, ...(text ? { note: text } : {}) });
          break;
        case "budget": {
          // Only the same line counts: `/budget` or `/budget <tokens>`.
          const amount = (text.split(/\r?\n/)[0] ?? "").trim();
          events.push({ kind: "budget_continue", source, comment_id, approver: who, amount: amount === "" ? null : amount });
          break;
        }
        case "resolve": {
          const onPr = cm.html_url?.includes("/pull/") ? await this.factoryPull(base, Number(cm.issue_url.split("/").pop())) : null;
          if (cm.html_url?.includes("/pull/") && !onPr) break;
          events.push({ kind: "resolve_requested", source, comment_id, requester: who, notes: text, pr: onPr });
          break;
        }
        case "help":
          events.push({ kind: "help_requested", source, comment_id, requester: who });
          break;
        case "verdict": {
          const target = await this.verdictTarget(Number(cm.issue_url.split("/").pop()));
          if (target) events.push({ kind: "verdict_submitted", target, comment_id, approver: who, args: text });
          break;
        }
      }
    }

    // Pulls have no `since`: read newest-updated first and stop at the cursor, without reading the pages
    // past it (design §5 Sources, GitHub call budget).
    // Every PR, not only factory ones (design 2026-11-01): a merge with no work item is an unreviewed merge.
    const pastCursor = (page: GhPull[]) => c.pulls !== null && (page.at(-1)?.updated_at ?? "") < c.pulls;
    const pulls = await this.client.list<GhPull>(`${base}/pulls?state=closed&sort=updated&direction=desc`, c.pulls ? 5 : 1, pastCursor);
    for (const p of pulls) {
      if (c.pulls && p.updated_at < c.pulls) break;
      next.pulls = max(next.pulls, p.updated_at);
      const fork = this.isFork(p) ? { fork: true as const } : {};
      if (p.merged_at && p.merge_commit_sha) {
        // The list endpoint omits merged_by; the single-PR endpoint has it.
        const full = await this.client.request<Pick<GhPullFull, "merged_by">>("GET", `${base}/pulls/${p.number}`);
        events.push({
          kind: "pr_merged",
          pr_number: p.number,
          head_branch: p.head.ref,
          merge_sha: p.merge_commit_sha,
          merger: full.merged_by ? identity(full.merged_by) : null,
          ...fork,
        });
      } else {
        events.push({ kind: "pr_closed", pr_number: p.number, head_branch: p.head.ref, ...fork });
      }
    }

    // Open PRs. Not cursored: reported on every poll while open. pr_open for every factory PR and every other
    // non-draft PR against the base from this repository (design 2026-11-01); the controller reads more about a
    // PR only when it does not know it yet. Then factory PRs that cannot merge into their base: the controller
    // keys the update on (head sha, base sha). The list endpoint omits `mergeable`.
    const open = await this.client.list<GhPull>(`${base}/pulls?state=open&sort=updated&direction=desc`);
    // Under the budget threshold the reads below wait for the reset; the next poll makes them (they are not cursored,
    // or keep their cursor). The intake lists above always run.
    const low = this.client.lowBudget();
    const reviewed: GhPull[] = [];
    for (const p of open) {
      const factory = p.head.ref.startsWith(this.branchPrefix);
      if (p.base.ref === this.baseBranch && !this.isFork(p) && (factory || !p.draft)) {
        reviewed.push(p);
        events.push({
          kind: "pr_open",
          source: this.prRef(p.number),
          pr_number: p.number,
          head_branch: p.head.ref,
          head_sha: p.head.sha,
          title: p.title ?? "",
          body: p.body ?? "",
          author: p.user ? identity(p.user) : null,
          labels: (p.labels ?? []).map((l) => l.name),
        });
      }
      if (!factory || low) continue;
      const full = await this.client.request<GhPullFull>("GET", `${base}/pulls/${p.number}`);
      if (full.mergeable !== false) continue;
      events.push({
        kind: "pr_unmergeable",
        pr_number: full.number,
        head_branch: full.head.ref,
        head_sha: full.head.sha,
        base_sha: full.base.sha,
      });
    }

    // "Request changes" reviews on the PRs reported open, after their pr_open (design §4).
    if (!low) events.push(...(await this.changeRequests(base, reviewed, c, next)));

    // Commits on the base branch, for revert tracking (design §6). Newest first; delivered oldest first.
    // Under the budget threshold the cursor stays put, so the next poll reads them.
    const commits = low ? [] : await this.client.list<GhCommit>(
      `${base}/commits?sha=${encodeURIComponent(this.baseBranch)}` + (c.commits ? `&since=${c.commits}` : ""),
      COMMIT_PAGES,
    );
    const already = new Set(c.commits ? (c.commit_shas ?? []) : []);
    next.commits = c.commits ?? null;
    next.commit_shas = [...already];
    for (const cm of [...commits].reverse()) {
      const date = cm.commit.committer?.date;
      if (already.has(cm.sha)) continue;
      already.add(cm.sha);
      events.push({ kind: "base_commit", sha: cm.sha, message: cm.commit.message });
      if (!date) continue;
      if (next.commits === null || date > next.commits) {
        next.commits = date;
        next.commit_shas = [cm.sha];
      } else if (date === next.commits) {
        next.commit_shas.push(cm.sha);
      }
    }

    events.push(...closes);
    return { events, next_cursor: JSON.stringify(next) };
  }

  /**
   * The PR's number and head branch if it is a factory PR; null for another PR or one that is gone (404), so
   * a stray comment cannot wedge the poll. Other errors are thrown and the poll is retried.
   */
  private async factoryPull(base: string, n: number): Promise<{ pr_number: number; head_branch: string } | null> {
    try {
      const p = await this.client.request<Pick<GhPull, "number" | "head">>("GET", `${base}/pulls/${n}`);
      return p.head.ref.startsWith(this.branchPrefix) ? { pr_number: p.number, head_branch: p.head.ref } : null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * The PR's number and head branch, whatever the branch; null for one that is gone (404). Other errors are
   * thrown and the poll is retried.
   */
  private async pullHead(base: string, n: number): Promise<{ pr_number: number; head_branch: string } | null> {
    try {
      const p = await this.client.request<Pick<GhPull, "number" | "head">>("GET", `${base}/pulls/${n}`);
      return { pr_number: p.number, head_branch: p.head.ref };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * One pr_changes_requested per "Request changes" review by a person (not a bot) submitted since the cursor's
   * review time, on the open PRs given that were updated since then, with the review's line comments. Approvals,
   * plain comments, dismissed and pending reviews give nothing. With no review time yet, sets it and reads none.
   */
  private async changeRequests(base: string, pulls: GhPull[], c: Cursor, next: Cursor): Promise<SourceEvent[]> {
    const newest = pulls.reduce<string | null>((m, p) => max(m, p.updated_at), null);
    if (!c.reviews) {
      next.reviews = newest;
      next.review_ids = [];
      return [];
    }
    const since = c.reviews;
    const already = new Set(c.review_ids ?? []);
    const mark = max(since, newest ?? since);
    const seen: number[] = [];
    const events: SourceEvent[] = [];
    for (const p of pulls) {
      if (p.updated_at < since) continue;
      for (const r of await this.client.list<GhReview>(`${base}/pulls/${p.number}/reviews`, 3)) {
        if (!r.submitted_at || r.submitted_at < since || already.has(r.id)) continue;
        if (r.submitted_at >= mark) seen.push(r.id);
        if (r.state !== "CHANGES_REQUESTED" || !r.user || r.user.type === "Bot") continue;
        const comments = await this.client.list<GhReviewComment>(`${base}/pulls/${p.number}/reviews/${r.id}/comments`, 3);
        events.push({
          kind: "pr_changes_requested",
          source: this.prRef(p.number),
          pr_number: p.number,
          head_branch: p.head.ref,
          review_id: String(r.id),
          reviewer: identity(r.user),
          body: r.body ?? "",
          comments: comments.map((cm): PrLineComment => ({ path: cm.path, line: cm.line ?? cm.original_line ?? null, body: cm.body })),
        });
      }
    }
    next.reviews = mark;
    // Ids read at exactly the old time stay known while the time does not move.
    next.review_ids = mark === since ? [...already, ...seen] : seen;
    return events;
  }

  /** A head in another repository, or in one that was deleted. A list without `repo` (older fixtures) counts as ours. */
  private isFork(p: GhPull): boolean {
    if (p.head.repo === undefined) return false;
    return p.head.repo === null || p.head.repo.full_name.toLowerCase() !== `${this.repo.owner}/${this.repo.name}`.toLowerCase();
  }

  /** Every path the PR changes, both sides of a rename. GitHub lists at most 3000 files per PR. */
  async prFiles(pr_number: number): Promise<string[]> {
    const files = await this.client.list<GhPullFile>(`/repos/${this.repo.owner}/${this.repo.name}/pulls/${pr_number}/files`, 30);
    const paths = new Set<string>();
    for (const f of files) {
      paths.add(f.filename);
      if (f.previous_filename) paths.add(f.previous_filename);
    }
    return [...paths];
  }

  /** The actor of the latest `labeled` event for `label` in the issue or PR timeline; null when none. */
  async labelAddedBy(number: number, label: string): Promise<ExternalIdentity | null> {
    const events = await this.client.list<GhTimelineEvent>(`/repos/${this.repo.owner}/${this.repo.name}/issues/${number}/timeline`, 10);
    const added = events.filter((e) => e.event === "labeled" && e.label?.name === label).at(-1);
    return added?.actor ? identity(added.actor) : null;
  }

  /** The account linked to the commit's author, or null (an email GitHub does not know). */
  async commitAuthor(sha: string): Promise<ExternalIdentity | null> {
    const c = await this.client.request<{ author: GhUser | null }>(
      "GET", `/repos/${this.repo.owner}/${this.repo.name}/commits/${encodeURIComponent(sha)}`);
    return c.author ? identity(c.author) : null;
  }

  /** source_closed for each closed factory issue updated since the cursor; pull requests are skipped. */
  private async closedIssues(c: Cursor, next: Cursor): Promise<SourceEvent[]> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const issues = await this.client.list<GhIssue>(
      `${base}/issues?state=closed&labels=${encodeURIComponent(this.label)}&sort=updated&direction=asc` +
        (c.closed ? `&since=${c.closed}` : ""),
    );
    const already = new Set(c.closed ? (c.closed_numbers ?? []) : []);
    next.closed = c.closed ?? null;
    next.closed_numbers = [...already];
    const events: SourceEvent[] = [];
    for (const i of issues) {
      if (i.updated_at === c.closed && already.has(i.number)) continue;
      if (next.closed === null || i.updated_at > next.closed) {
        next.closed = i.updated_at;
        next.closed_numbers = [i.number];
      } else if (i.updated_at === next.closed) {
        next.closed_numbers.push(i.number);
      }
      if (i.pull_request) continue;
      // The list endpoint omits closed_by; the single-issue endpoint has it.
      const full = await this.client.request<Pick<GhIssueFull, "closed_by" | "state_reason">>("GET", `${base}/issues/${i.number}`);
      events.push({
        kind: "source_closed",
        source: this.ref(i.number),
        closer: full.closed_by ? identity(full.closed_by) : null,
        state_reason: closeReason(full.state_reason),
      });
    }
    return events;
  }

  /**
   * Posts once per marker. A marker the store has a record of costs no call: its stored URL is returned, whatever
   * the body (the comment is not edited). Otherwise the thread is read once for the marker (a post from before the
   * store kept records, or one whose record write failed), the comment is posted if it is not there, and its ID,
   * URL and body hash are stored. A failed post is counted in the store and the next try waits its backoff
   * (commentBackoffMs): until then this throws without a call, on any replica.
   */
  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const stored = await this.store?.getPostedComment(source.id, marker, body);
    if (stored?.comment_id) return { url: stored.url };
    if (stored?.waiting) {
      throw new Error(`comment post waits until ${stored.next_attempt_at} after ${stored.attempts} failed attempts`);
    }
    try {
      const comment = await this.findOrPost(source, body, marker);
      const url = comment?.html_url ?? null;
      if (comment?.id !== undefined) {
        await this.store?.recordPostedComment({ source_id: source.id, marker, comment_id: String(comment.id), url, body });
      }
      return { url };
    } catch (err) {
      const attempts = (stored?.attempts ?? 0) + 1;
      await this.store?.recordCommentFailure(source.id, marker, attempts, commentBackoffMs(attempts));
      throw err;
    }
  }

  /** The thread's comment carrying `marker`, else a new one with it. */
  private async findOrPost(source: SourceRef, body: string, marker: string): Promise<{ id: number; html_url?: string } | undefined> {
    const path = `/repos/${this.repo.owner}/${this.repo.name}/issues/${issueNumberFromSourceId(source.id)}/comments`;
    return (await this.client.list<{ id: number; body?: string; html_url?: string }>(path, THREAD_PAGES)).find((c) => c.body?.includes(marker))
      ?? await this.client.request<{ id: number; html_url?: string } | undefined>("POST", path, { body: `${body}\n\n${marker}` });
  }

  /** Closes the issue as "not planned" (or `reason`). GitHub accepts the same PATCH on an issue that is already closed. */
  async closeIssue(source: SourceRef, reason: SourceCloseReason = "not_planned"): Promise<void> {
    await this.client.request("PATCH", `/repos/${this.repo.owner}/${this.repo.name}/issues/${issueNumberFromSourceId(source.id)}`, {
      state: "closed",
      state_reason: reason,
    });
  }

  /**
   * One phase as a factory-labelled issue linked under the parent. The marker is looked up first among the
   * parent's sub-issues, then among the newest 300 factory-labelled issues (open or closed; one filed by a
   * try that failed before its link), so a retry never files a second issue. A link GitHub refuses with 422
   * (already linked by a concurrent try) counts once the parent lists it.
   */
  async fileSubIssue(input: SubIssueInput): Promise<SourceRef> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const parent = issueNumberFromSourceId(input.parent.id);
    const subs = `${base}/issues/${parent}/sub_issues`;
    const has = (i: GhIssueRef) => !i.pull_request && (i.body ?? "").includes(input.marker);
    const linked = (await this.client.list<GhIssueRef>(subs, 1)).find(has);
    if (linked) return this.ref(linked.number);
    const filed = (await this.client.list<GhIssueRef>(
      `${base}/issues?state=all&labels=${encodeURIComponent(this.label)}&sort=created&direction=desc`, 3)).find(has);
    const issue = filed ?? await this.client.request<GhIssueRef>("POST", `${base}/issues`, {
      title: input.title,
      body: `${input.body}\n\n${input.marker}`,
      labels: [this.label],
    });
    try {
      await this.client.request("POST", subs, { sub_issue_id: issue.id });
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
      if (!(await this.client.list<GhIssueRef>(subs, 1)).some((i) => i.number === issue.number)) throw err;
    }
    return this.ref(issue.number);
  }

  /**
   * The items an issue waits for (design §5, 2026-11-03), each once, in this order: `Depends on` lines in its
   * body, its sub-issues (a parent waits for its sub-issues), and its blocked-by links. A list GitHub does not
   * offer (404 or 410: the feature is off) gives no links. Read-only.
   */
  async dependencyLinks(source: SourceRef): Promise<DependencyLink[]> {
    const repo = `${this.repo.owner}/${this.repo.name}`;
    const base = `/repos/${repo}/issues/${issueNumberFromSourceId(source.id)}`;
    const issue = await this.client.request<Pick<GhIssue, "body">>("GET", base);
    const links: DependencyLink[] = parseDependsOn(issue?.body ?? "", repo).map((d) => ({ depends_on: d, kind: "depends_on" }));
    const add = (i: GhLinkedIssue, kind: DependencyLink["kind"]) => {
      const id = `${repoOf(i.repository_url) ?? repo}#${i.number}`;
      if (Number.isInteger(i.number) && i.number > 0 && !links.some((l) => l.depends_on === id)) links.push({ depends_on: id, kind });
    };
    for (const i of await this.optionalList<GhLinkedIssue>(`${base}/sub_issues`)) add(i, "sub_issue");
    for (const i of await this.optionalList<GhLinkedIssue>(`${base}/dependencies/blocked_by`)) add(i, "blocked_by");
    return links.filter((l) => l.depends_on !== source.id);
  }

  /**
   * An item the store does not track: open; merged (a PR merged, or an issue closed as completed); or closed
   * without that. Read-only: one GET.
   */
  async dependencyState(depends_on: string): Promise<DependencyState> {
    const [repo, n] = depends_on.split("#");
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !n) throw new Error(`not a GitHub issue source id: ${depends_on}`);
    const i = await this.client.request<GhLinkedIssue>("GET", `/repos/${repo}/issues/${issueNumberFromSourceId(depends_on)}`);
    if (i.state === "open") return "open";
    if (i.pull_request) return i.pull_request.merged_at ? "merged" : "closed_unmerged";
    return i.state_reason === "completed" ? "merged" : "closed_unmerged";
  }

  /** A list GET whose endpoint may be off for this repository (404, 410): empty then. */
  private async optionalList<T>(path: string): Promise<T[]> {
    try {
      return await this.client.list<T>(path, 1);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return [];
      throw err;
    }
  }

  /**
   * Reads the PR; if it is still open, posts the comment (once per marker) naming who closed the issue, then
   * closes the PR (state closed, never a merge). A merged or closed PR is left alone.
   */
  async closePr(input: ClosePrInput): Promise<"closed" | "not_open"> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const pull = await this.client.request<{ state: string }>("GET", `${base}/pulls/${input.pr_number}`);
    if (pull.state !== "open") return "not_open";
    let closer: ExternalIdentity | null = null;
    if (input.closed.type === "github_issue") {
      const issue = await this.client.request<Pick<GhIssueFull, "closed_by">>(
        "GET", `${base}/issues/${issueNumberFromSourceId(input.closed.id)}`);
      closer = issue.closed_by ? identity(issue.closed_by) : null;
    }
    await this.client.commentOnce(this.repo, input.pr_number, input.body(closer), input.marker);
    await this.client.request("PATCH", `${base}/pulls/${input.pr_number}`, { state: "closed" });
    return "closed";
  }

  /** 👀 on the comment, or on the issue when `commentId` is null. GitHub returns the existing reaction if present. */
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}/issues`;
    const path = commentId === null
      ? `${base}/${issueNumberFromSourceId(source.id)}/reactions`
      : `${base}/comments/${encodeURIComponent(commentId)}/reactions`;
    await this.client.request("POST", path, { content: "eyes" });
  }

  /**
   * One status label on the issue, or on PR `pr_number` (PRs share the issue labels API): read its labels;
   * if the target is missing, create the label if missing and add it; then remove the other seven fixed status
   * names. Nothing more when the labels are already right. Any other label, including one a human made under
   * the same prefix, is left alone. Each step is idempotent.
   *
   * With a store, the label state stored for the item and target decides first: the same status makes no call,
   * and a different one (or none stored) is written under a store claim, so of two replicas only one writes it,
   * then stored. A failed write ends its claim and stores nothing.
   */
  async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    if (!this.store) return this.writeStatus(source, status, pr_number);
    const target = labelTarget(pr_number);
    const token = await this.store.claimLabelWrite(source.id, target, status, LABEL_CLAIM_MS);
    if (token === null) return;
    try {
      await this.writeStatus(source, status, pr_number);
    } catch (err) {
      await this.store.releaseLabelClaim(source.id, target, token);
      throw err;
    }
    await this.store.recordLabelState(source.id, target, status, token);
  }

  private async writeStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    const repo = `/repos/${this.repo.owner}/${this.repo.name}`;
    const n = pr_number ?? issueNumberFromSourceId(source.id);
    const all = statusLabels(this.statusPrefix);
    const target = all.find((l) => l.status === status)!;
    const others = new Set(all.filter((l) => l !== target).map((l) => l.name));
    // Read first (a conditional GET): a label already right costs one call, or none on a 304 (GitHub call budget).
    const current = (await this.client.list<{ name: string }>(`${repo}/issues/${n}/labels`, 1)).map((l) => l.name);
    const stale = current.filter((name) => others.has(name));
    if (current.includes(target.name) && stale.length === 0) return;
    if (!current.includes(target.name)) {
      await ensureLabel(this.client, this.repo, target);
      await this.client.request("POST", `${repo}/issues/${n}/labels`, { labels: [target.name] });
    }
    for (const name of stale) {
      try {
        await this.client.request("DELETE", `${repo}/issues/${n}/labels/${encodeURIComponent(name)}`);
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
      }
    }
  }

  /**
   * The checks on the PR's current head commit: its check runs (GitHub Actions and apps; the latest run per
   * name, GitHub's default) and its commit statuses (older integrations). Three read-only GETs and at most
   * CHECK_PAGES pages of check runs. A check run with a conclusion other than success, neutral or skipped,
   * and a status in `failure` or `error`, is failed; any unfinished one is pending; none at all is passed.
   */
  async prChecks(pr_number: number): Promise<PrChecks> {
    // Under the budget threshold the gate waits (pending) and a later pass reads the checks.
    if (this.client.lowBudget()) return { state: "pending" };
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const pull = await this.client.request<Pick<GhPull, "head">>("GET", `${base}/pulls/${pr_number}`);
    const sha = encodeURIComponent(pull.head.sha);
    const runs: GhCheckRun[] = [];
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const r = await this.client.request<{ total_count: number; check_runs: GhCheckRun[] }>(
        "GET", `${base}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      runs.push(...r.check_runs);
      if (r.check_runs.length < 100 || runs.length >= r.total_count) break;
    }
    const status = await this.client.request<{ statuses: GhStatus[] }>("GET", `${base}/commits/${sha}/status?per_page=100`);

    const failed: string[] = [];
    let pending = false;
    for (const r of runs) {
      if (r.status !== "completed") pending = true;
      else if (!PASSING_CONCLUSIONS.has(r.conclusion ?? "")) failed.push(r.name);
    }
    for (const s of status.statuses) {
      if (s.state === "pending") pending = true;
      else if (s.state !== "success") failed.push(s.context);
    }
    if (failed.length) return { state: "failed", failed };
    return pending ? { state: "pending" } : { state: "passed" };
  }

  /**
   * Where a `/verdict` comment was written. Issue comments and PR conversation comments share one list;
   * the issue's `pull_request` field tells them apart. A PR names its head branch, so the controller can
   * map it to the work item; a PR not on a factory branch gives null (not the factory's, ignored).
   */
  private async verdictTarget(number: number): Promise<VerdictEventTarget | null> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const issue = await this.client.request<Pick<GhIssue, "pull_request">>("GET", `${base}/issues/${number}`);
    if (!issue.pull_request) return { kind: "issue", source: this.ref(number) };
    const pull = await this.client.request<Pick<GhPull, "head">>("GET", `${base}/pulls/${number}`);
    if (!pull.head.ref.startsWith(this.branchPrefix)) return null;
    return { kind: "pr", pr_number: number, head_branch: pull.head.ref };
  }

  /** A pull request as a source: same id space as issues (comments and labels share the issues API), its own link. */
  private prRef(number: number): SourceRef {
    return {
      type: "github_issue",
      id: `${this.repo.owner}/${this.repo.name}#${number}`,
      link: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${number}`,
    };
  }

  private ref(number: number): SourceRef {
    return {
      type: "github_issue",
      id: `${this.repo.owner}/${this.repo.name}#${number}`,
      link: `https://github.com/${this.repo.owner}/${this.repo.name}/issues/${number}`,
    };
  }
}

function identity(u: GhUser): ExternalIdentity {
  return { provider: "github", subject: String(u.id), login: u.login };
}

/** "owner/name" from an API repository URL (`.../repos/<owner>/<name>`), or null. */
function repoOf(url: string | undefined): string | null {
  const m = /\/repos\/([^/]+\/[^/]+)\/?$/.exec(url ?? "");
  return m ? m[1]! : null;
}

/** GitHub's issue state_reason, as far as the factory reads it. */
function closeReason(r: string | null | undefined): SourceCloseReason | null {
  return r === "completed" || r === "not_planned" ? r : null;
}

function max(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

/**
 * Creates the repository label. Returns "created", or "exists" when GitHub answers 422 already_exists;
 * any other error is thrown.
 */
export async function ensureLabel(
  client: GitHubClient,
  repo: RepoRef,
  label: { name: string; color: string; description: string },
): Promise<"created" | "exists"> {
  try {
    await client.request("POST", `/repos/${repo.owner}/${repo.name}/labels`, {
      name: label.name,
      color: label.color,
      description: label.description,
    });
    return "created";
  } catch (err) {
    if (err instanceof GitHubError && err.status === 422 && err.message.includes("already_exists")) return "exists";
    throw err;
  }
}
