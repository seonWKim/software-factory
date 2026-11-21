// Forge fakes (RFC 0023 R4).
import { execFileSync } from "node:child_process";
import type { WorkStatus } from "../../../src/core/status-label.js";
import type { PrCheckResult, SourceRef } from "../../../src/core/types.js";
import type { ExternalIdentity } from "../../../src/interfaces/auth-provider.js";
import type { BranchPushInput, ChangeLinks, ClosePrInput, Forge, ForgeEvent, ForgePollResult, OpenPrInput, PrChecks, PrMergeMethod, PrMergeResult } from "../../../src/interfaces/forge.js";
import { githubLinks } from "../../../src/impl/github/github-forge.js";
import type { FakeSource } from "./source.js";

/**
 * A forge over in-memory PRs of repo o/r (issue #273): `queue` holds the PR events the next poll delivers, the PR
 * facts answer from the maps below, and PR comments and PR status are recorded. `source`: the FakeSource whose
 * delivered closes name who closed an item, as GitHub's issue does for closePr.
 */
export class FakeForge implements Forge {
  readonly ref_type = "github_issue" as const;
  queue: ForgeEvent[] = [];
  /** Every poll call, failed ones included, with the cursor it was given. */
  polls: (string | null)[] = [];
  /** When set, poll throws this instead of returning events. */
  pollError: Error | null = null;
  /** PR comments postPrComment posted, at most one per marker; `url` stands in for the comment URL. */
  comments: { pr_number: number; body: string; marker: string; url: string }[] = [];
  /** When set, postPrComment throws this. */
  commentError: Error | null = null;
  /** Every setPrStatus call, in order, including ones that threw. */
  statusCalls: { source: SourceRef; status: WorkStatus; pr_number: number }[] = [];
  /** When set, setPrStatus records the call, then throws this. */
  statusError: Error | null = null;

  constructor(
    private readonly source: Pick<FakeSource, "closers"> | null = null,
    /**
     * A forge-write log to add outbound's pushes and PR opens to, as FakeBroker's `calls` (RFC 0015 M7): named by the
     * forge.* tool that made them before they moved to outbound, so a flow's writes read in the order they hit the forge.
     */
    private readonly writes: { name: string; args: unknown }[] | null = null,
  ) {}

  /** Every pushBranch call outbound made (RFC 0015 M7), failed ones included, in order. */
  pushes: BranchPushInput[] = [];
  /** The forge's branches: a successful pushBranch moves its branch here. */
  branches = new Map<string, string>();
  /** Thrown by the next pushBranch calls, oldest first, before anything is pushed. */
  pushErrors: Error[] = [];
  async pushBranch(input: BranchPushInput): Promise<"pushed" | "already"> {
    this.pushes.push(input);
    this.writes?.push({ name: "forge.push_branch", args: input });
    const err = this.pushErrors.shift();
    if (err) throw err;
    if (this.branches.get(input.branch) === input.sha) return "already";
    this.branches.set(input.branch, input.sha);
    return "pushed";
  }
  /** Every openPr call, failed ones included, in order. */
  prOpens: OpenPrInput[] = [];
  /** Thrown by the next openPr calls, oldest first. */
  prErrors: Error[] = [];
  /** The PR number a branch's PR gets (absent: 42), and its link. */
  prNumbers = new Map<string, number>();
  async openPr(input: OpenPrInput): Promise<{ number: number; url: string | null }> {
    this.prOpens.push(input);
    this.writes?.push({ name: "forge.open_change", args: input });
    const err = this.prErrors.shift();
    if (err) throw err;
    const n = this.prNumbers.get(input.branch) ?? 42;
    return { number: n, url: this.prRef(n).link };
  }

  /** Open PRs by number: like GitHub's, each is reported (change_open) on every poll while it is here, after `queue`. */
  openPrs = new Map<number, Extract<ForgeEvent, { kind: "change_open" }>>();

  async poll(cursor: string | null): Promise<ForgePollResult> {
    this.polls.push(cursor);
    if (this.pollError) throw this.pollError;
    const events = [...this.queue, ...this.openPrs.values()];
    this.queue = [];
    return { events, next_cursor: String(Number(cursor ?? "0") + 1) };
  }
  /** Its PRs are GitHub-numbered, so its links read GitHub's forms. */
  parseLinks(message: string): ChangeLinks {
    return githubLinks(message);
  }
  prRef(pr_number: number): SourceRef {
    return { type: "github_issue", id: `o/r#${pr_number}`, link: `https://github.com/o/r/pull/${pr_number}` };
  }
  /** Like GitHub's: only a ref equal to its own prRef (another repository's PR is not one). */
  prNumberOf(ref: SourceRef): number | null {
    const m = /\/pull\/(\d+)$/.exec(ref.link);
    if (ref.type !== "github_issue" || !m) return null;
    const ours = this.prRef(Number(m[1]));
    return ours.id === ref.id && ours.link === ref.link ? Number(m[1]) : null;
  }
  async postPrComment(pr_number: number, body: string, marker: string): Promise<{ url: string }> {
    if (this.commentError) throw this.commentError;
    const existing = this.comments.find((c) => c.marker === marker);
    if (existing) return { url: existing.url };
    const url = `${this.prRef(pr_number).link}#issuecomment-${this.comments.length + 1}`;
    this.comments.push({ pr_number, body, marker, url });
    return { url };
  }
  async setPrStatus(source: SourceRef, status: WorkStatus, pr_number: number): Promise<void> {
    this.statusCalls.push({ source, status, pr_number });
    if (this.statusError) throw this.statusError;
  }
  /** The status the PR was last set to, or null. */
  prStatus(pr_number: number): WorkStatus | null {
    return this.statusCalls.filter((c) => c.pr_number === pr_number).at(-1)?.status ?? null;
  }
  /** PR states; a PR not listed is open. closePr turns an open one `closed`. */
  prStates = new Map<number, "open" | "closed" | "merged">();
  /** Comments closePr posted on PRs, at most one per marker. */
  prComments: { pr_number: number; body: string; marker: string }[] = [];
  /** Every closePr call, failed ones included, in order. */
  prCloseCalls: number[] = [];
  /** When set, closePr posts its comment, then throws this instead of closing the PR. */
  prCloseError: Error | null = null;
  /** When set, closePr throws this before posting anything. */
  prCommentError: Error | null = null;
  async closePr(input: ClosePrInput): Promise<"closed" | "not_open"> {
    this.prCloseCalls.push(input.pr);
    if ((this.prStates.get(input.pr) ?? "open") !== "open") return "not_open";
    if (this.prCommentError) throw this.prCommentError;
    if (!this.prComments.some((c) => c.marker === input.marker)) {
      const closer = this.source?.closers.get(input.closed.id) ?? null;
      this.prComments.push({ pr_number: input.pr, body: input.body(closer), marker: input.marker });
    }
    if (this.prCloseError) throw this.prCloseError;
    this.prStates.set(input.pr, "closed");
    return "closed";
  }
  /**
   * A test-only override of prChecks: scripted summaries, one per call, oldest first. Once empty, prChecks sums
   * `checkList` up as the real forges sum their check results: any failed check fails it (with the failed names),
   * else any pending one keeps it pending, else (no check at all included) passed.
   */
  checkResults: PrChecks[] = [];
  /** Every PR number prChecks was asked about, in order. */
  checkCalls: number[] = [];
  /** When set, prChecks records the call, then throws this. */
  checksError: Error | null = null;
  async prChecks(pr_number: number): Promise<PrChecks> {
    this.checkCalls.push(pr_number);
    if (this.checksError) throw this.checksError;
    const scripted = this.checkResults.shift();
    if (scripted) return scripted;
    const failed = this.checkList.filter((c) => c.result === "failed").map((c) => c.name);
    if (failed.length) return { state: "failed", failed };
    return this.checkList.some((c) => c.result === "pending") ? { state: "pending" } : { state: "passed" };
  }
  /** What prCheckResults answers (each check's name and result); every PR asked for is recorded in `checkResultCalls`. */
  checkList: PrCheckResult[] = [];
  checkResultCalls: number[] = [];
  /** When set, prCheckResults records the call, then throws this. */
  checkListError: Error | null = null;
  async prCheckResults(pr_number: number): Promise<PrCheckResult[]> {
    this.checkResultCalls.push(pr_number);
    if (this.checkListError) throw this.checkListError;
    return this.checkList;
  }
  /** What prFiles answers per PR number (absent: []). Every PR asked for is recorded in `fileCalls`. */
  prFileMap: Record<number, string[]> = {};
  fileCalls: number[] = [];
  async prFiles(pr_number: number): Promise<string[]> {
    this.fileCalls.push(pr_number);
    return this.prFileMap[pr_number] ?? [];
  }
  /** Who added a label, by `${number}:${label}` (absent: null). */
  labelAdders: Record<string, ExternalIdentity> = {};
  async labelAddedBy(number: number, label: string): Promise<ExternalIdentity | null> {
    return this.labelAdders[`${number}:${label}`] ?? null;
  }
  /** The author of a commit, by sha (absent: null). */
  commitAuthors: Record<string, ExternalIdentity> = {};
  async commitAuthor(sha: string): Promise<ExternalIdentity | null> {
    return this.commitAuthors[sha] ?? null;
  }
  /** The commit count per `${from}..${to}` (absent: null, unknown). Every range asked for is recorded in `betweenCalls`. */
  commitCounts: Record<string, number> = {};
  betweenCalls: string[] = [];
  async commitsBetween(from_sha: string, to_sha: string): Promise<number | null> {
    this.betweenCalls.push(`${from_sha}..${to_sha}`);
    return this.commitCounts[`${from_sha}..${to_sha}`] ?? null;
  }
  /** Each PR's head as the forge sees it, by number (absent: the head the merge names, so it merges). */
  prHeads: Record<number, string> = {};
  /** Each merged PR's merge commit, by number: mergePr sets it; a test sets it for a PR merged outside the factory. */
  mergeShas: Record<number, string> = {};
  /** Every mergePr call, failed ones included, in order. */
  mergeCalls: { pr: number; head_sha: string; method: string }[] = [];
  /** When set, mergePr records the call, then throws this. */
  mergeError: Error | null = null;
  /** As GitHub's merge endpoint: a merged PR answers its sha (`already`), a moved head is refused, else it merges. */
  async mergePr(pr: number, head_sha: string, method: PrMergeMethod): Promise<PrMergeResult> {
    this.mergeCalls.push({ pr, head_sha, method });
    if (this.mergeError) throw this.mergeError;
    const done = this.mergeShas[pr];
    if (done !== undefined) return { merged: true, sha: done, already: true };
    if ((this.prHeads[pr] ?? head_sha) !== head_sha) return { merged: false, refused: "GitHub refused the merge: the PR head moved since the review passed" };
    const sha = `merge-${pr}`;
    this.mergeShas[pr] = sha;
    this.prStates.set(pr, "merged");
    return { merged: true, sha, already: false };
  }
}

/**
 * A FakeForge whose pushBranch also pushes for real, as the GitHub forge does (RFC 0015 M7): the stored sha from the
 * factory repo to its origin (a local bare repo, no credential), never forced.
 */
export class GitForge extends FakeForge {
  override async pushBranch(input: BranchPushInput): Promise<"pushed" | "already"> {
    const r = await super.pushBranch(input);
    execFileSync("git", ["push", "--quiet", "origin", `${input.sha}:refs/heads/${input.branch}`], {
      cwd: input.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return r;
  }
}
