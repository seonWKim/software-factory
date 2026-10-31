import type { SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { PollResult, SourceAdapter, SourceEvent } from "../../interfaces/source-adapter.js";
import { type GitHubClient, type RepoRef, issueNumberFromSourceId } from "../github/github-client.js";

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
      const [first = "", ...rest] = cm.body.trim().split(/\r?\n/);
      const command = first.trim();
      if (command === "/approve") events.push({ kind: "spec_approved", source, comment_id, approver: identity(cm.user) });
      else if (command.startsWith("/reject")) {
        const reason = [command.slice("/reject".length).trim(), ...rest].join("\n").trim();
        events.push({ kind: "spec_rejected", source, comment_id, approver: identity(cm.user), reason });
      } else if (command === "/retry") {
        events.push({ kind: "retry_requested", source, comment_id, requester: identity(cm.user) });
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

  /** 👀 on the comment, or on the issue when `commentId` is null. GitHub returns the existing reaction if present. */
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}/issues`;
    const path = commentId === null
      ? `${base}/${issueNumberFromSourceId(source.id)}/reactions`
      : `${base}/comments/${encodeURIComponent(commentId)}/reactions`;
    await this.client.request("POST", path, { content: "eyes" });
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
