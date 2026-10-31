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
  head: { ref: string };
}

interface Cursor {
  issues: string | null;
  comments: string | null;
  pulls: string | null;
}

export class GitHubIssueSource implements SourceAdapter {
  readonly type = "github_issue" as const;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: RepoRef,
    private readonly label: string,
    private readonly branchPrefix: string,
  ) {}

  async poll(cursor: string | null): Promise<PollResult> {
    const c: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : { issues: null, comments: null, pulls: null };
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const events: SourceEvent[] = [];
    const next: Cursor = { ...c };

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
    for (const cm of comments) {
      next.comments = max(next.comments, cm.updated_at);
      if (cm.user.type === "Bot") continue;
      const source = this.ref(Number(cm.issue_url.split("/").pop()));
      const [first = "", ...rest] = cm.body.trim().split(/\r?\n/);
      const command = first.trim();
      if (command === "/approve") events.push({ kind: "spec_approved", source, approver: identity(cm.user) });
      else if (command.startsWith("/reject")) {
        const reason = [command.slice("/reject".length).trim(), ...rest].join("\n").trim();
        events.push({ kind: "spec_rejected", source, approver: identity(cm.user), reason });
      } else if (command === "/retry") events.push({ kind: "retry_requested", source, requester: identity(cm.user) });
    }

    // Pulls have no `since`: read newest-updated first and stop at the cursor.
    const pulls = await this.client.list<GhPull>(`${base}/pulls?state=closed&sort=updated&direction=desc`, c.pulls ? 5 : 1);
    for (const p of pulls) {
      if (c.pulls && p.updated_at < c.pulls) break;
      next.pulls = max(next.pulls, p.updated_at);
      if (!p.head.ref.startsWith(this.branchPrefix)) continue;
      if (p.merged_at && p.merge_commit_sha) {
        // The list endpoint omits merged_by; the single-PR endpoint has it.
        const full = await this.client.request<{ merged_by: GhUser | null }>("GET", `${base}/pulls/${p.number}`);
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

    return { events, next_cursor: JSON.stringify(next) };
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<void> {
    await this.client.commentOnce(this.repo, issueNumberFromSourceId(source.id), body, marker);
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
