import { type CommandPr, githubCommand, githubCommentKey, syncedCommand } from "../../core/command-inbox.js";
import { parseComment } from "../../core/commands.js";
import { type DependencyLink, type DependencySource, parseDependsOn } from "../../core/coordination.js";
import { incompleteLabel } from "../../core/pr-body.js";
import { workItemIdFromBranch } from "../../core/policy.js";
import { WORK_STATUSES, type WorkStatus } from "../../core/status-label.js";
import type { Logger } from "../../core/log.js";
import type { DependencyState, SourceRef, WorkItemId } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { Clock } from "../../interfaces/clock.js";
import { type FactoryStore, type NewCliCommand, labelTarget } from "../../interfaces/factory-store.js";
import type {
  IssueInput, PollResult, PollSource, SourceCloseReason, SourceEvent, SubIssueInput, VerdictEventTarget,
} from "../../interfaces/source-adapter.js";
import { type GitHubClient, GitHubError, type RepoRef, issueNumberFromSourceId } from "../github/github-client.js";

export interface GhUser {
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
/** Whether an issue (not a PR) carries `marker` in its body. */
function carries(marker: string): (i: GhIssueRef) => boolean {
  return (i) => !i.pull_request && (i.body ?? "").includes(marker);
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
/** A new comment as the poll read it: its command inbox row (null for a plain comment) and PR context. */
interface ReadComment {
  cm: GhComment;
  source: SourceRef;
  command: NewCliCommand | null;
  pr: CommandPr | null;
}
/** A PR as the comment commands need it: its number and head branch. */
interface GhPullHead {
  number: number;
  head: { ref: string };
}
interface GhCommit {
  sha: string;
  commit: { message: string; committer: { date: string } | null };
}

/**
 * The source's cursor. Cursors written before issue #273 also hold the PR position (`pulls`, `start`, `reviews`,
 * ...): carried along unread; the forge starts from them (GitHubForge.handover_cursor).
 */
interface Cursor {
  issues: string | null;
  comments: string | null;
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
   * True while a first start's closed-issue backlog is still being read: each issue's full read takes the client's
   * catch-up allowance (GitHubClient.takeCatchUp), and the cursor stops at the last one read. Absent: caught up.
   */
  closed_catch_up?: boolean;
}

/** What the GitHub forge's poll needs beyond the client: the Clock the starting point comes from, `github.history_since`, a log. */
export interface PollContext {
  clock: Clock;
  /** In GitHub's UTC format (githubHistorySince); null when not set. */
  history_since: string | null;
  log: Logger;
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

/** A time in the UTC format GitHub returns for updated_at: `2026-11-07T00:00:00Z`, no milliseconds. */
export function githubTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * `github.history_since`: how far back the GitHub forge checks merges (design §5, Merges). Absent: null. A date or an ISO
 * time, returned in GitHub's UTC format; anything else throws an error naming the setting (startup fails).
 */
export function githubHistorySince(github: { history_since?: unknown } | undefined): string | null {
  const v = github?.history_since;
  if (v === undefined || v === null) return null;
  const ms = typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v) ? Date.parse(v) : NaN;
  if (Number.isNaN(ms)) {
    throw new Error(`github.history_since must be a date like 2026-01-01 or a UTC time like 2026-01-01T00:00:00Z, got ${JSON.stringify(v) ?? String(v)}`);
  }
  return githubTime(new Date(ms));
}

/**
 * GitHub issues as a source: issues, their comments, base-branch commits and dependency links. Pull requests are
 * the GitHub forge's (src/impl/github/github-forge.ts, issue #273), which posts PR comments and labels through this
 * class's store-backed postComment and setStatus.
 */
export class GitHubIssueSource implements PollSource, DependencySource {
  readonly type = "github_issue" as const;
  readonly intake = "poll" as const;
  /** The intake label is the gate: a refused issue gets no reply. */
  readonly silent_intake_refusal = true as const;

  constructor(
    private readonly client: GitHubClient,
    private readonly repo: RepoRef,
    private readonly label: string,
    private readonly branchPrefix: string,
    private readonly baseBranch: string,
    private readonly statusPrefix: string = DEFAULT_STATUS_LABEL_PREFIX,
    /**
     * Where posted comments and written labels are recorded, shared by every replica (design §5, GitHub call
     * budget). Without one every post reads the thread and every status reads the labels.
     */
    private readonly store: FactoryStore | null = null,
  ) {}

  async poll(cursor: string | null): Promise<PollResult> {
    const c: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : { issues: null, comments: null };
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
        updated_at: i.updated_at,
      });
    }

    // Closed factory issues, delivered last. The controller polls the forge after this read (a merge that closes its
    // issue happens before the close, so the forge's read already sees it) and handles its events first.
    const closes = await this.closedIssues(c, next);

    const comments = await this.client.list<GhComment>(
      `${base}/issues/comments?sort=updated&direction=asc` + (c.comments ? `&since=${c.comments}` : ""),
    );
    const seen = new Set<number>();
    const read: ReadComment[] = [];
    for (const cm of comments) {
      next.comments = max(next.comments, cm.updated_at);
      // Compare with the previous poll's mark, not the running one: this page is ordered by updated_at, not id.
      if ((c.last_comment_id != null && cm.id <= c.last_comment_id) || seen.has(cm.id)) continue;
      seen.add(cm.id);
      next.last_comment_id = Math.max(next.last_comment_id ?? 0, cm.id);
      if (cm.user.type === "Bot") continue;
      const r = await this.readComment(base, cm);
      if (r) read.push(r);
    }
    // In comment-id order, so the commands of one poll are applied in the order they were written (issue #284).
    read.sort((a, b) => a.cm.id - b.cm.id);
    for (const r of read) events.push(...(await this.recordComment(r)));

    // Commits on the base branch, for revert tracking (design §6). Newest first; delivered oldest first.
    // Under the budget threshold the cursor stays put, so the next poll reads them. With no cursor yet (a first
    // start) the pages are catch-up reads: as many as this minute's allowance grants, none when it is used.
    const pages = this.client.lowBudget() ? 0 : c.commits ? COMMIT_PAGES : this.client.takeCatchUp(COMMIT_PAGES);
    const commits = pages === 0 ? [] : await this.client.list<GhCommit>(
      `${base}/commits?sha=${encodeURIComponent(this.baseBranch)}` + (c.commits ? `&since=${c.commits}` : ""),
      pages,
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
   * One new comment by a person: a plain comment on an issue, or a command as its command inbox row with the PR
   * context a command on a PR's conversation needs (read here, so applying it reads nothing more). Null for what
   * is left alone: a plain comment on a PR's conversation (design §4), a `/revise` on a PR that is gone, a
   * `/resolve` or `/verdict` on a PR that is not a factory PR.
   */
  private async readComment(base: string, cm: GhComment): Promise<ReadComment | null> {
    const n = Number(cm.issue_url.split("/").pop());
    const source = this.ref(n);
    const onPr = cm.html_url?.includes("/pull/") ?? false;
    const parsed = parseComment(cm.body);
    if (parsed === null) return onPr ? null : { cm, source, command: null, pr: null };
    let pr: CommandPr | null = null;
    if (parsed.kind === "command" && parsed.name === "verdict") {
      const target = await this.verdictTarget(n);
      if (!target) return null;
      if (target.kind === "pr") pr = { pr_number: target.pr_number, head_branch: target.head_branch };
    } else if (onPr && parsed.kind === "command" && (parsed.name === "revise" || parsed.name === "resolve")) {
      // `/revise`: any PR of this repository (factory or adopted); `/resolve`: factory PRs only.
      pr = parsed.name === "revise" ? await this.pullHead(base, n) : await this.factoryPull(base, n);
      if (!pr) return null;
    }
    const command = githubCommand({
      comment_id: cm.id, user_id: cm.user.id, source, pr,
      ...(parsed.kind === "unknown" ? { command: parsed.word, text: "" } : { command: parsed.name, text: parsed.text }),
    });
    return { cm, source, command, pr };
  }

  /**
   * Stores one comment (issue #284): a command once in the command inbox, which the controller applies from, and
   * the comment once in its work item's thread (an issue that is no work item has no thread), both keyed on
   * `github:<comment id>`, so a repeat poll or a second replica writes nothing more. The thread entry's actor is
   * `github:<numeric user id>`; the controller resolves a command's actor through the linked account. Returns the events the
   * controller still takes from the poll: a plain comment's (for `/link` and suggestions). Without a store a
   * command is returned as the event its row maps to.
   */
  private async recordComment(r: ReadComment): Promise<SourceEvent[]> {
    const { cm, source, command, pr } = r;
    const plain: SourceEvent[] = command
      ? []
      : [{ kind: "plain_comment", source, comment_id: String(cm.id), author: identity(cm.user), body: cm.body }];
    if (!this.store) {
      const e = command ? syncedCommand(command)?.event : null;
      return e ? [e] : plain;
    }
    const item = await this.itemOf(source, pr);
    // The author as the account's numeric ID, never the login: the audit of who wrote a refused command too.
    if (item) await this.store.recordItemMessage({ work_item_id: item, marker: githubCommentKey(cm.id), body: cm.body, actor: `github:${cm.user.id}` });
    if (command) await this.store.appendCliCommand(command);
    return plain;
  }

  /** The work item a comment belongs to: the one with this issue (or adopted PR) as its source, else a factory PR's. */
  private async itemOf(source: SourceRef, pr: CommandPr | null): Promise<WorkItemId | null> {
    const own = await this.store!.getWorkItemBySource(source.type, source.id);
    if (own) return own.id;
    const id = pr ? workItemIdFromBranch(pr.head_branch, this.branchPrefix) : null;
    const it = id ? await this.store!.getWorkItem(id as WorkItemId) : null;
    return it && it.pr_number === pr?.pr_number ? it.id : null;
  }

  /**
   * The PR's number and head branch if it is a factory PR; null for another PR or one that is gone (404), so
   * a stray comment cannot wedge the poll. Other errors are thrown and the poll is retried.
   */
  private async factoryPull(base: string, n: number): Promise<{ pr_number: number; head_branch: string } | null> {
    try {
      const p = await this.client.request<GhPullHead>("GET", `${base}/pulls/${n}`);
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
      const p = await this.client.request<GhPullHead>("GET", `${base}/pulls/${n}`);
      return { pr_number: p.number, head_branch: p.head.ref };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * source_closed for each closed factory issue updated since the cursor; pull requests are skipped. A first start
   * (no cursor) is a catch-up: each issue's full read takes the client's catch-up allowance, and when it runs out the
   * cursor stops at the last issue read, so the backlog is spread over several polls (design §5, GitHub call budget).
   */
  private async closedIssues(c: Cursor, next: Cursor): Promise<SourceEvent[]> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const issues = await this.client.list<GhIssue>(
      `${base}/issues?state=closed&labels=${encodeURIComponent(this.label)}&sort=updated&direction=asc` +
        (c.closed ? `&since=${c.closed}` : ""),
    );
    const catchUp = c.closed == null || c.closed_catch_up === true;
    const already = new Set(c.closed ? (c.closed_numbers ?? []) : []);
    next.closed = c.closed ?? null;
    next.closed_numbers = [...already];
    delete next.closed_catch_up;
    const events: SourceEvent[] = [];
    for (const i of issues) {
      if (i.updated_at === c.closed && already.has(i.number)) continue;
      if (!i.pull_request && catchUp && this.client.takeCatchUp(1) === 0) {
        next.closed_catch_up = true;
        break;
      }
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
    const linked = (await this.client.list<GhIssueRef>(subs, 1)).find(carries(input.marker));
    if (linked) return this.ref(linked.number);
    const issue = await this.findOrFile(input, [this.label]);
    try {
      await this.client.request("POST", subs, { sub_issue_id: issue.id });
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
      if (!(await this.client.list<GhIssueRef>(subs, 1)).some((i) => i.number === issue.number)) throw err;
    }
    return this.ref(issue.number);
  }

  /**
   * One standalone issue without the intake label, so a person starts it (design §7). The marker is looked up
   * first among the newest 300 issues (open or closed), so a retry after a failure part way files no second one.
   */
  async fileIssue(input: IssueInput): Promise<SourceRef> {
    return this.ref((await this.findOrFile(input, [])).number);
  }

  /** The newest 300 issues with `labels` (open or closed) carrying the marker, else a new issue with them. */
  private async findOrFile(input: Pick<IssueInput, "title" | "body" | "marker">, labels: string[]): Promise<GhIssueRef> {
    const base = `/repos/${this.repo.owner}/${this.repo.name}`;
    const filter = labels.length === 0 ? "" : `&labels=${encodeURIComponent(labels.join(","))}`;
    const filed = (await this.client.list<GhIssueRef>(`${base}/issues?state=all${filter}&sort=created&direction=desc`, 3)).find(carries(input.marker));
    return filed ?? await this.client.request<GhIssueRef>("POST", `${base}/issues`, {
      title: input.title,
      body: `${input.body}\n\n${input.marker}`,
      ...(labels.length === 0 ? {} : { labels }),
    });
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

  /** The client's rate-limit budget (`GitHubClient.lowBudget`): true while optional reads should wait. */
  lowBudget(): boolean {
    return this.client.lowBudget();
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
    const pull = await this.client.request<GhPullHead>("GET", `${base}/pulls/${number}`);
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

export function identity(u: GhUser): ExternalIdentity {
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

export function max(a: string | null, b: string): string {
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
