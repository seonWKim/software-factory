import { parseComment } from "../../core/commands.js";
import { WORK_STATUSES, type WorkStatus } from "../../core/status-label.js";
import type { SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type {
  ClosePrInput, PollResult, PollSource, PrChecks, SourceCloseReason, SourceEvent, SubIssueInput, VerdictEventTarget,
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

/** Check-run pages read per prChecks call, 100 each. */
const CHECK_PAGES = 3;
/** Check-run conclusions that do not fail the gate. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Commit pages read per poll, 100 each, newest first. Older commits in the window are not read. */
const COMMIT_PAGES = 5;

export class GitHubIssueSource implements PollSource {
  readonly type = "github_issue" as const;
  readonly intake = "poll" as const;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: RepoRef,
    private readonly label: string,
    private readonly branchPrefix: string,
    private readonly baseBranch: string,
    private readonly statusPrefix: string = DEFAULT_STATUS_LABEL_PREFIX,
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
          events.push({ kind: "revise_requested", source, comment_id, requester: who, feedback: text });
          break;
        case "retry":
          events.push({ kind: "retry_requested", source, comment_id, requester: who });
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

    // Pulls have no `since`: read newest-updated first and stop at the cursor.
    // Every PR, not only factory ones (design 2026-11-01): a merge with no work item is an unreviewed merge.
    const pulls = await this.client.list<GhPull>(`${base}/pulls?state=closed&sort=updated&direction=desc`, c.pulls ? 5 : 1);
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
    for (const p of open) {
      const factory = p.head.ref.startsWith(this.branchPrefix);
      if (p.base.ref === this.baseBranch && !this.isFork(p) && (factory || !p.draft)) {
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
      if (!factory) continue;
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

    // Commits on the base branch, for revert tracking (design §6). Newest first; delivered oldest first.
    const commits = await this.client.list<GhCommit>(
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

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const { url } = await this.client.commentOnce(this.repo, issueNumberFromSourceId(source.id), body, marker);
    return { url };
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
   * One status label on the issue, or on PR `pr_number` (PRs share the issue labels API): create the label
   * if missing, add it, then remove the other seven fixed status names. Any other label, including one a
   * human made under the same prefix, is left alone. Each step is idempotent.
   */
  async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    const repo = `/repos/${this.repo.owner}/${this.repo.name}`;
    const n = pr_number ?? issueNumberFromSourceId(source.id);
    const all = statusLabels(this.statusPrefix);
    const target = all.find((l) => l.status === status)!;
    await ensureLabel(this.client, this.repo, target);
    await this.client.request("POST", `${repo}/issues/${n}/labels`, { labels: [target.name] });
    const others = new Set(all.filter((l) => l !== target).map((l) => l.name));
    const current = await this.client.list<{ name: string }>(`${repo}/issues/${n}/labels`, 1);
    for (const { name } of current) {
      if (!others.has(name)) continue;
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
