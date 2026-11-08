import type { WorkStatus } from "../../core/status-label.js";
import type { PrCheckResult, SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import { FORGE_AUTH, GITHUB_RATE_LIMITED, NETWORK_UNAVAILABLE, githubRateLimitMessage, networkDetail, unreachableHost } from "../../core/policy.js";
import type { BasePushInput, BranchPushInput, ClosePrInput, Forge, OpenPrInput, ForgeEvent, ForgePollResult, PrChecks, PrLineComment } from "../../interfaces/forge.js";
import type { GitHubApi, GitHubCredentials } from "../../interfaces/github-credentials.js";
import { factoryGit, factoryRemoteUrl } from "../broker/trusted-git.js";
import { GitHubError, GitHubRateLimitError, type RepoRef, issueNumberFromSourceId } from "../github/github-client.js";
import { forgeAuthRefused, openOrUpdatePr } from "./pull-requests.js";
import { type GhUser, type GitHubIssueSource, type PollContext, githubTime, identity, max } from "./github-issue-source.js";

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
interface GhPullFull extends GhPull {
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  merged_by: GhUser | null;
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

/**
 * The forge's cursor. Its fields kept the same names and meaning when they moved out of the GitHub source's cursor
 * (issue #273), so the source's old cursor (`handover_cursor`) is a valid first cursor; its other fields are ignored.
 */
interface Cursor {
  /** Newest updated_at of a closed PR already read; the closed-PR list stops there. */
  pulls?: string | null;
  /**
   * Reviews (design §4): reviews submitted before this time are never delivered, and only open PRs updated at
   * or after it are read. `review_ids` are the reviews already read that were submitted at or after it. Absent
   * on the first poll: that poll sets the time to the newest open PR update and delivers no review, so a review
   * from before the factory read reviews starts nothing.
   */
  reviews?: string | null;
  review_ids?: number[];
  /**
   * The starting point (design §5, Merges): a PR merged before it is never checked (no merger read, no
   * change_merged). Set once: the first poll takes it from the Clock; a cursor written before it existed takes its
   * `pulls` time, so an install that already runs reads no history. Only `github.history_since` moves it, back.
   */
  start?: string;
  /** The `github.history_since` value already acted on, so a restart neither reads that history again nor warns again. */
  history_since?: string | null;
}

/** Check-run pages read per prCheckResults call, 100 each. */
const CHECK_PAGES = 3;
/** Check-run conclusions that do not fail the gate. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
/** Closed-PR pages read past a cursor or back to `github.history_since`, 100 each, newest-updated first. */
const CLOSED_PULL_PAGES = 5;

/**
 * The GitHub forge (issue #273): every PR read the factory makes, and its PR comments and PR labels. Those two go
 * through `issues`, the GitHub source's store-backed post and label paths, so a PR comment or label is recorded
 * like an issue one (design §5, GitHub sync records). PR refs share the issues' id space (`owner/name#N`).
 */
export class GitHubForge implements Forge {
  readonly ref_type = "github_issue" as const;
  /** Before issue #273 the GitHub source kept the PR position in its own cursor. */
  readonly handover_cursor = "intake:github_issue";

  constructor(
    private readonly client: GitHubApi,
    private readonly repo: RepoRef,
    private readonly branchPrefix: string,
    private readonly baseBranch: string,
    private readonly issues: Pick<GitHubIssueSource, "postComment" | "setStatus">,
    /** Required to poll. */
    private readonly pollContext: PollContext | null = null,
    /** Required to push a run's branch (RFC 0015 M7): only outbound's targets call the forge, so only they hold it (G2). */
    private readonly credentials: GitHubCredentials | null = null,
  ) {}

  private get base(): string {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }

  /**
   * Closed PRs since the cursor, then the open PRs: change_open for each reported one, change_unmergeable for factory PRs
   * that cannot merge, and the "Request changes" reviews on the reported ones. Under the budget threshold the
   * per-PR reads wait for the reset; the next poll makes them (they are not cursored, or keep their cursor).
   */
  async poll(cursor: string | null): Promise<ForgePollResult> {
    if (!this.pollContext) throw new Error("GitHubForge.poll needs a PollContext (clock, history_since, log)");
    const c: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : {};
    const next: Cursor = { pulls: c.pulls ?? null, reviews: c.reviews ?? null, review_ids: c.review_ids ?? [] };
    const events: ForgeEvent[] = await this.closedPulls(c, next, this.pollContext);

    // Open PRs. Not cursored: reported on every poll while open. change_open for every factory PR and every other
    // non-draft PR against the base from this repository (design 2026-11-01); the controller reads more about a
    // PR only when it does not know it yet. Then factory PRs that cannot merge into their base: the controller
    // keys the update on (head sha, base sha). The list endpoint omits `mergeable`.
    const open = await this.client.list<GhPull>(`${this.base}/pulls?state=open&sort=updated&direction=desc`);
    const low = this.client.lowBudget();
    const reviewed: GhPull[] = [];
    for (const p of open) {
      const factory = p.head.ref.startsWith(this.branchPrefix);
      if (p.base.ref === this.baseBranch && !this.isFork(p) && (factory || !p.draft)) {
        reviewed.push(p);
        events.push({
          kind: "change_open",
          source: this.prRef(p.number),
          change_ref: String(p.number),
          head_branch: p.head.ref,
          head_sha: p.head.sha,
          title: p.title ?? "",
          body: p.body ?? "",
          author: p.user ? identity(p.user) : null,
          labels: (p.labels ?? []).map((l) => l.name),
        });
      }
      if (!factory || low) continue;
      const full = await this.client.request<GhPullFull>("GET", `${this.base}/pulls/${p.number}`);
      if (full.mergeable !== false) continue;
      events.push({ kind: "change_unmergeable", change_ref: String(full.number), head_branch: full.head.ref, head_sha: full.head.sha, base_sha: full.base.sha });
    }

    // "Request changes" reviews on the PRs reported open, after their change_open (design §4).
    if (!low) events.push(...(await this.changeRequests(reviewed, c, next)));
    return { events, next_cursor: JSON.stringify(next) };
  }

  /**
   * change_merged and change_closed for every PR (not only factory ones, design 2026-11-01: a merge with no work item is
   * an unreviewed merge) updated since the cursor. Pulls have no `since`: read newest-updated first and stop at
   * the cursor, without reading the pages past it (GitHub call budget). A merge before the starting point gets
   * no merger read and no event, so a first start flags no past merge. A `github.history_since` older than the
   * starting point moves it back once: that poll reads back to it, at most CLOSED_PULL_PAGES pages.
   */
  private async closedPulls(c: Cursor, next: Cursor, ctx: PollContext): Promise<ForgeEvent[]> {
    let start = c.start ?? c.pulls ?? githubTime(ctx.clock.now());
    let stop = c.pulls ?? null;
    const since = ctx.history_since;
    next.history_since = c.history_since ?? null;
    if (since !== null && since !== c.history_since) {
      next.history_since = since;
      if (since < start) {
        start = since;
        stop = since;
      } else {
        ctx.log.warn("github.history_since is not before the starting point: ignored", { history_since: since, start });
      }
    }
    next.start = start;
    const pastStop = (page: GhPull[]) => stop !== null && (page.at(-1)?.updated_at ?? "") < stop;
    const pulls = await this.client.list<GhPull>(`${this.base}/pulls?state=closed&sort=updated&direction=desc`, stop ? CLOSED_PULL_PAGES : 1, pastStop);
    const events: ForgeEvent[] = [];
    for (const p of pulls) {
      if (stop && p.updated_at < stop) break;
      next.pulls = max(next.pulls ?? null, p.updated_at);
      const fork = this.isFork(p) ? { fork: true as const } : {};
      if (p.merged_at && p.merge_commit_sha) {
        if (p.merged_at < start) continue;
        // The list endpoint omits merged_by; the single-PR endpoint has it.
        const full = await this.client.request<Pick<GhPullFull, "merged_by">>("GET", `${this.base}/pulls/${p.number}`);
        events.push({
          kind: "change_merged",
          change_ref: String(p.number),
          head_branch: p.head.ref,
          merge_sha: p.merge_commit_sha,
          merger: full.merged_by ? identity(full.merged_by) : null,
          ...fork,
        });
      } else {
        events.push({ kind: "change_closed", change_ref: String(p.number), head_branch: p.head.ref, ...fork });
      }
    }
    // With no closed PR read yet, the next poll still stops at the starting point.
    next.pulls ??= start;
    return events;
  }

  /**
   * One pr_changes_requested per "Request changes" review by a person (not a bot) submitted since the cursor's
   * review time, on the open PRs given that were updated since then, with the review's line comments. Approvals,
   * plain comments, dismissed and pending reviews give nothing. With no review time yet, sets it and reads none.
   */
  private async changeRequests(pulls: GhPull[], c: Cursor, next: Cursor): Promise<ForgeEvent[]> {
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
    const events: ForgeEvent[] = [];
    for (const p of pulls) {
      if (p.updated_at < since) continue;
      for (const r of await this.client.list<GhReview>(`${this.base}/pulls/${p.number}/reviews`, 3)) {
        if (!r.submitted_at || r.submitted_at < since || already.has(r.id)) continue;
        if (r.submitted_at >= mark) seen.push(r.id);
        if (r.state !== "CHANGES_REQUESTED" || !r.user || r.user.type === "Bot") continue;
        const comments = await this.client.list<GhReviewComment>(`${this.base}/pulls/${p.number}/reviews/${r.id}/comments`, 3);
        events.push({
          kind: "pr_changes_requested",
          source: this.prRef(p.number),
          change_ref: String(p.number),
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

  /** A pull request as a target: same id space as issues (comments and labels share the issues API), its own link. */
  prRef(pr: number): SourceRef {
    return {
      type: this.ref_type,
      id: `${this.repo.owner}/${this.repo.name}#${pr}`,
      link: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${pr}`,
    };
  }

  prNumberOf(ref: SourceRef): number | null {
    const m = /\/pull\/(\d+)$/.exec(ref.link);
    if (ref.type !== this.ref_type || !m) return null;
    const ours = this.prRef(Number(m[1]));
    return ours.id === ref.id && ours.link === ref.link ? Number(m[1]) : null;
  }

  postPrComment(pr: number, body: string, marker: string): Promise<{ url: string | null }> {
    return this.issues.postComment(this.prRef(pr), body, marker);
  }

  setPrStatus(source: SourceRef, status: WorkStatus, pr: number): Promise<void> {
    return this.issues.setStatus(source, status, String(pr));
  }

  /** Every path the PR changes, both sides of a rename. GitHub lists at most 3000 files per PR. */
  async prFiles(pr: number): Promise<string[]> {
    const files = await this.client.list<GhPullFile>(`${this.base}/pulls/${pr}/files`, 30);
    const paths = new Set<string>();
    for (const f of files) {
      paths.add(f.filename);
      if (f.previous_filename) paths.add(f.previous_filename);
    }
    return [...paths];
  }

  /** The actor of the latest `labeled` event for `label` in the PR's timeline; null when none. */
  async labelAddedBy(pr: number, label: string): Promise<ExternalIdentity | null> {
    const events = await this.client.list<GhTimelineEvent>(`${this.base}/issues/${pr}/timeline`, 10);
    const added = events.filter((e) => e.event === "labeled" && e.label?.name === label).at(-1);
    return added?.actor ? identity(added.actor) : null;
  }

  /** The account linked to the commit's author, or null (an email GitHub does not know). */
  async commitAuthor(sha: string): Promise<ExternalIdentity | null> {
    const c = await this.client.request<{ author: GhUser | null }>("GET", `${this.base}/commits/${encodeURIComponent(sha)}`);
    return c.author ? identity(c.author) : null;
  }

  /**
   * The compare endpoint's `ahead_by` (one GET). Null when GitHub cannot compare the two (404 or 422: a sha it does
   * not know, e.g. after a force-push) or gives no count. Other failures throw.
   */
  async commitsBetween(from_sha: string, to_sha: string): Promise<number | null> {
    const range = `${encodeURIComponent(from_sha)}...${encodeURIComponent(to_sha)}`;
    try {
      const c = await this.client.request<{ ahead_by?: unknown }>("GET", `${this.base}/compare/${range}`);
      return typeof c?.ahead_by === "number" && Number.isInteger(c.ahead_by) && c.ahead_by >= 0 ? c.ahead_by : null;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return null;
      throw err;
    }
  }

  /**
   * Reads the PR; if it is still open, posts the comment (once per marker) naming who closed the issue (when the
   * closed item is a GitHub issue), then closes the PR (state closed, never a merge). A merged or closed PR is left alone.
   */
  async closePr(input: ClosePrInput): Promise<"closed" | "not_open"> {
    const pull = await this.client.request<{ state: string }>("GET", `${this.base}/pulls/${input.pr}`);
    if (pull.state !== "open") return "not_open";
    let closer: ExternalIdentity | null = null;
    if (input.closed.type === this.ref_type) {
      const issue = await this.client.request<{ closed_by: GhUser | null }>("GET", `${this.base}/issues/${issueNumberFromSourceId(input.closed.id)}`);
      closer = issue.closed_by ? identity(issue.closed_by) : null;
    }
    await this.client.commentOnce(this.repo, input.pr, input.body(closer), input.marker);
    await this.client.request("PATCH", `${this.base}/pulls/${input.pr}`, { state: "closed" });
    return "closed";
  }

  /**
   * The base push (design 05-sources, Local items): one `git push` from the factory repo to its `origin`, of `sha` to
   * the base branch, with `--force-with-lease` on `expected_sha`, so it lands only while the remote base is still
   * the one the factory read (and `sha` descends from it, so it is a fast-forward). `--no-verify`: no hook runs. The
   * push goes through the factory repo's own git configuration for origin, as its fetches do; it makes no API call.
   */
  async pushBase(input: BasePushInput): Promise<void> {
    if (input.base_ref !== this.baseBranch) throw new Error(`refusing to push ${JSON.stringify(input.base_ref)}: the base branch is ${this.baseBranch}`);
    for (const sha of [input.sha, input.expected_sha]) {
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
    }
    const ref = `refs/heads/${input.base_ref}`;
    const r = await factoryGit(input.repo, ["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${input.expected_sha}`, "origin", `${input.sha}:${ref}`]);
    if (r.exit_code !== 0) throw new Error(`git push failed: ${r.stderr.trim().slice(0, 500)}`);
  }

  /**
   * A run's push (RFC 0015 M7), from the factory repo where the run's last step wrote the commit: to the remote URL
   * the factory repo names for origin, with the token only through this child's env and an inline credential helper
   * (never argv), never forced, `--no-verify`. Reconciles first with one `ls-remote`: the branch already at the sha
   * is `already`, no push. A failure throws with its class first (`network_unavailable`, `forge_auth`, `push_failed`).
   */
  async pushBranch(input: BranchPushInput): Promise<"pushed" | "already"> {
    if (!input.branch.startsWith(this.branchPrefix)) throw new Error(`push_failed: refusing to push ${JSON.stringify(input.branch)}: not a factory branch`);
    if (!/^[0-9a-f]{40,64}$/.test(input.sha)) throw new Error(`push_failed: not a commit sha: ${JSON.stringify(input.sha)}`);
    const remote = await factoryRemoteUrl(input.repo);
    if (!("url" in remote)) throw new Error(`push_failed: ${remote.message}`);
    const token = await this.credentials?.token();
    if (!token) throw new Error(`${FORGE_AUTH}: GitHub credentials missing`);
    const helper = '!f() { echo username=x-access-token; echo "password=$SF_GIT_TOKEN"; }; f';
    const auth = ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
    const env = { SF_GIT_TOKEN: token.reveal() };
    const ref = `refs/heads/${input.branch}`;
    const fail = (stderr: string): Error => {
      const host = unreachableHost(stderr);
      if (host !== null) return new Error(`${NETWORK_UNAVAILABLE}: ${networkDetail(host)}`);
      return new Error(`${forgeAuthRefused(stderr) ? FORGE_AUTH : "push_failed"}: ${stderr.trim().slice(0, 500)}`);
    };
    const ls = await factoryGit(input.repo, [...auth, "ls-remote", remote.url, ref], env);
    if (ls.exit_code !== 0) throw fail(ls.stderr);
    if (ls.stdout.split(/\s+/)[0] === input.sha) return "already";
    const r = await factoryGit(input.repo, [...auth, "push", "--quiet", "--no-verify", remote.url, `${input.sha}:${ref}`], env);
    if (r.exit_code !== 0) throw fail(r.stderr);
    return "pushed";
  }

  /** The factory branch's PR opened, or the open one updated (`openOrUpdatePr`); a failure throws with its class first. */
  async openPr(input: OpenPrInput): Promise<{ number: number; url: string | null }> {
    if (!input.branch.startsWith(this.branchPrefix)) throw new Error(`pr_failed: refusing a PR for ${JSON.stringify(input.branch)}: not a factory branch`);
    try {
      return await openOrUpdatePr(this.client, this.repo, input);
    } catch (err) {
      if (err instanceof GitHubRateLimitError) throw new Error(`${GITHUB_RATE_LIMITED}: ${githubRateLimitMessage("open_pr", err.reset_at)}`);
      if (err instanceof GitHubError && (err.status === 401 || err.status === 403)) throw new Error(`${FORGE_AUTH}: open_pr: GitHub refused the credentials (${err.status})`);
      throw err;
    }
  }

  /**
   * The CI gate's summary of prCheckResults: any failed check fails it (with the failed names), else any pending
   * one keeps it pending, else (none at all included) it passed. Under the budget threshold the gate waits
   * (pending) and a later pass reads the checks.
   */
  async prChecks(pr: number): Promise<PrChecks> {
    if (this.client.lowBudget()) return { state: "pending" };
    const results = await this.prCheckResults(pr);
    const failed = results.filter((r) => r.result === "failed").map((r) => r.name);
    if (failed.length) return { state: "failed", failed };
    return results.some((r) => r.result === "pending") ? { state: "pending" } : { state: "passed" };
  }

  /**
   * Each check on the PR's current head commit: its check runs (GitHub Actions and apps; the latest run per name,
   * GitHub's default), then its commit statuses (older integrations). Three read-only GETs and at most CHECK_PAGES
   * pages of check runs. A check run with a conclusion other than success, neutral or skipped, and a status in
   * `failure` or `error`, is failed; any unfinished one is pending. Under the budget threshold it reads nothing
   * and throws, so the review prompt says the results could not be read.
   */
  async prCheckResults(pr: number): Promise<PrCheckResult[]> {
    if (this.client.lowBudget()) throw new Error("GitHub request budget low: checks not read");
    const pull = await this.client.request<Pick<GhPull, "head">>("GET", `${this.base}/pulls/${pr}`);
    const sha = encodeURIComponent(pull.head.sha);
    const runs: GhCheckRun[] = [];
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const r = await this.client.request<{ total_count: number; check_runs: GhCheckRun[] }>(
        "GET", `${this.base}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      runs.push(...r.check_runs);
      if (r.check_runs.length < 100 || runs.length >= r.total_count) break;
    }
    const status = await this.client.request<{ statuses: GhStatus[] }>("GET", `${this.base}/commits/${sha}/status?per_page=100`);
    return [
      ...runs.map((r): PrCheckResult => ({
        name: r.name,
        result: r.status !== "completed" ? "pending" : PASSING_CONCLUSIONS.has(r.conclusion ?? "") ? "passed" : "failed",
      })),
      ...status.statuses.map((s): PrCheckResult => ({
        name: s.context,
        result: s.state === "pending" ? "pending" : s.state === "success" ? "passed" : "failed",
      })),
    ];
  }
}
