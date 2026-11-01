import { parseComment } from "../../core/commands.js";
import { WORK_STATUSES, type WorkStatus } from "../../core/status-label.js";
import type { SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { PollResult, SourceAdapter, SourceEvent, VerdictEventTarget } from "../../interfaces/source-adapter.js";
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
interface GhComment {
  id: number;
  issue_url: string;
  body: string;
  user: GhUser;
  updated_at: string;
}
interface GhPull {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}
interface GhPullFull extends GhPull {
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  merged_by: GhUser | null;
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

/** Commit pages read per poll, 100 each, newest first. Older commits in the window are not read. */
const COMMIT_PAGES = 5;

export class GitHubIssueSource implements SourceAdapter {
  readonly type = "github_issue" as const;

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
      if (parsed === null) continue;
      const who = identity(cm.user);
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
    const pulls = await this.client.list<GhPull>(`${base}/pulls?state=closed&sort=updated&direction=desc`, c.pulls ? 5 : 1);
    for (const p of pulls) {
      if (c.pulls && p.updated_at < c.pulls) break;
      next.pulls = max(next.pulls, p.updated_at);
      if (!p.head.ref.startsWith(this.branchPrefix)) continue;
      if (p.merged_at && p.merge_commit_sha) {
        // The list endpoint omits merged_by; the single-PR endpoint has it.
        const full = await this.client.request<Pick<GhPullFull, "merged_by">>("GET", `${base}/pulls/${p.number}`);
        events.push({
          kind: "pr_merged",
          pr_number: p.number,
          head_branch: p.head.ref,
          merge_sha: p.merge_commit_sha,
          merger: full.merged_by ? identity(full.merged_by) : null,
        });
      } else {
        events.push({ kind: "pr_closed", pr_number: p.number, head_branch: p.head.ref });
      }
    }

    // Open factory PRs that cannot merge into their base. Not cursored: reported on every poll while it lasts,
    // and the controller keys the update on (head sha, base sha). The list endpoint omits `mergeable`.
    const open = await this.client.list<GhPull>(`${base}/pulls?state=open&sort=updated&direction=desc`);
    for (const p of open) {
      if (!p.head.ref.startsWith(this.branchPrefix)) continue;
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

    return { events, next_cursor: JSON.stringify(next) };
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<void> {
    await this.client.commentOnce(this.repo, issueNumberFromSourceId(source.id), body, marker);
  }

  /** Closes the issue as "not planned". GitHub accepts the same PATCH on an issue that is already closed. */
  async closeIssue(source: SourceRef): Promise<void> {
    await this.client.request("PATCH", `/repos/${this.repo.owner}/${this.repo.name}/issues/${issueNumberFromSourceId(source.id)}`, {
      state: "closed",
      state_reason: "not_planned",
    });
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
