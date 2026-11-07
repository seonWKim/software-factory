import type { WorkStatus } from "../../core/status-label.js";
import type { PrCheckResult, SourceRef } from "../../core/types.js";
import { TRUSTED_GIT_ENV } from "../../core/worker.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { ClosePrInput, Forge, ForgePollResult, MergePrInput, MergePrResult, PrChecks, PrMergeState } from "../../interfaces/forge.js";
import type { ExecResult } from "../../interfaces/sandbox.js";
import { baseEnv, runProcess } from "../process/run-process.js";

/** A branch name the local forge reads: a plain ref path, never an option or a refspec. */
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export interface LocalForgeOptions {
  /** The factory repo (`repo.path`): its refs are the PRs' branches and its base branch is merged into. */
  repo: string;
  /** `repo.base_branch`. */
  base: string;
  /** Who the merge commit names as author and committer (`agent_git_identity`). */
  identity: { name: string; email: string };
  /** Runs git; tests may pass their own. */
  run?: (cmd: readonly string[], opts: { cwd: string; env: Record<string, string> }) => Promise<ExecResult>;
}

/**
 * The local forge (design §4, merge command; issue #246): a factory PR is its branch in the factory repo, and a
 * merge puts that branch's commits on the base branch there, with no forge account and no GitHub call. The merge
 * works in git's object store only (`merge-tree --write-tree`, `commit-tree`, then a compare-and-swap `update-ref`
 * of the base), so no checkout, index or HEAD is touched; it refuses while the base is checked out anywhere, since
 * moving a checked-out branch would change that checkout's status. It reads no PR events (nothing is polled), has
 * no checks (`passed`) and posts nothing: a local item's thread is the store.
 */
export class LocalForge implements Forge {
  readonly ref_type = "local" as const;

  constructor(private readonly o: LocalForgeOptions) {}

  async poll(cursor: string | null): Promise<ForgePollResult> {
    return { events: [], next_cursor: cursor ?? "" };
  }

  prRef(pr_number: number): SourceRef {
    return { type: this.ref_type, id: `local-pr:${pr_number}`, link: "" };
  }

  prNumberOf(ref: SourceRef): number | null {
    const m = /^local-pr:(\d+)$/.exec(ref.id);
    return ref.type === this.ref_type && m ? Number(m[1]) : null;
  }

  async postPrComment(): Promise<{ url: string | null }> {
    return { url: null };
  }

  async setPrStatus(_source: SourceRef, _status: WorkStatus, _pr_number: number): Promise<void> {}

  /** No CI runs here: the pre-push checks already ran on the branch before it was pushed. */
  async prChecks(): Promise<PrChecks> {
    return { state: "passed" };
  }

  /** No CI runs on a local branch: no check results. */
  async prCheckResults(): Promise<PrCheckResult[]> {
    return [];
  }

  /** Nothing is adopted locally (no PR events), so no PR's files are ever asked for. */
  async prFiles(): Promise<string[]> {
    return [];
  }

  async labelAddedBy(): Promise<ExternalIdentity | null> {
    return null;
  }

  async commitAuthor(): Promise<ExternalIdentity | null> {
    return null;
  }

  /** Never read: a local forge reports no pushes (no PR events). */
  async commitsBetween(): Promise<number | null> {
    return null;
  }

  /** A local branch is never closed by the factory: the item closes, the branch stays. */
  async closePr(_input: ClosePrInput): Promise<"closed" | "not_open"> {
    return "not_open";
  }

  /**
   * The branch (a local branch first, else the fetched `origin/<branch>`) against the local base: merged when its
   * head is already on the base, closed when there is no such branch, else open with whether it merges cleanly
   * (`merge-tree`, objects only) and its size (`diff --numstat base...head`).
   */
  async prMergeState(_pr_number: number, branch: string): Promise<PrMergeState> {
    const head = await this.branchHead(branch);
    const base = await this.commit(`refs/heads/${this.o.base}`);
    if (base === null) throw new Error(`local forge: no branch ${this.o.base} in ${this.o.repo}`);
    const none = { lines: null, files: null };
    if (head === null) return { state: "closed", head_sha: null, mergeable: null, merge_sha: null, ...none };
    if ((await this.git(["merge-base", "--is-ancestor", head, base])).exit_code === 0) {
      return { state: "merged", head_sha: head, mergeable: null, merge_sha: base, ...none };
    }
    const tree = await this.mergeTree(base, head);
    const stat = await this.git(["diff", "--no-textconv", "--no-ext-diff", "--numstat", "-z", `${base}...${head}`]);
    let lines = 0;
    let files = 0;
    for (const entry of stat.stdout.split("\0")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!m) continue;
      files++;
      lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
    }
    const size = stat.exit_code === 0 ? { lines, files } : none;
    return { state: "open", head_sha: head, mergeable: tree !== null, merge_sha: null, ...size };
  }

  /**
   * One merge commit of base and the branch's head, written to the base with a compare-and-swap, so a base that
   * moved meanwhile is never overwritten. Refused (nothing written to any ref) when the head is not the reviewed
   * one, the base is checked out somewhere, or the merge conflicts.
   */
  async mergePr(input: MergePrInput): Promise<MergePrResult> {
    const head = await this.branchHead(input.branch);
    if (head !== input.head_sha) return { merged: false, reason: "the branch's head is not the reviewed head" };
    const base = await this.commit(`refs/heads/${input.base_ref}`);
    if (base === null) return { merged: false, reason: `there is no local branch \`${input.base_ref}\`` };
    const worktrees = await this.git(["worktree", "list", "--porcelain"]);
    if (worktrees.exit_code !== 0) throw gitError("worktree list", worktrees);
    if (worktrees.stdout.split("\n").includes(`branch refs/heads/${input.base_ref}`)) {
      return {
        merged: false,
        reason: `\`${input.base_ref}\` is checked out in a working tree of this repository, and the local forge never changes a checkout; switch it to another branch, then merge again`,
      };
    }
    const tree = await this.mergeTree(base, head);
    if (tree === null) return { merged: false, reason: `the branch does not merge cleanly into \`${input.base_ref}\`` };
    const { name, email } = this.o.identity;
    const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const message = `Merge branch '${input.branch}' (PR #${input.pr_number})`;
    const made = await this.git(["commit-tree", tree, "-p", base, "-p", head, "-m", message], who);
    if (made.exit_code !== 0) throw gitError("commit-tree", made);
    const commit = made.stdout.trim();
    const moved = await this.git(["update-ref", "-m", message, `refs/heads/${input.base_ref}`, commit, base], who);
    if (moved.exit_code !== 0) return { merged: false, reason: `\`${input.base_ref}\` moved during the merge; merge again` };
    return { merged: true, merge_sha: commit };
  }

  /** The merged tree of base and head, or null when they conflict. Writes objects only. */
  private async mergeTree(base: string, head: string): Promise<string | null> {
    const r = await this.git(["merge-tree", "--write-tree", "--no-messages", base, head]);
    if (r.exit_code === 1) return null;
    if (r.exit_code !== 0) throw gitError("merge-tree", r);
    return r.stdout.split("\n")[0]!.trim();
  }

  private async branchHead(branch: string): Promise<string | null> {
    if (!SAFE_BRANCH.test(branch) || branch.includes("..")) throw new Error(`local forge: refusing branch ${JSON.stringify(branch)}`);
    return (await this.commit(`refs/heads/${branch}`)) ?? this.commit(`refs/remotes/origin/${branch}`);
  }

  private async commit(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    return r.exit_code === 0 ? r.stdout.trim() : null;
  }

  private git(args: string[], extra: Record<string, string> = {}): Promise<ExecResult> {
    const run = this.o.run ?? runProcess;
    return run(["git", "-C", this.o.repo, ...args], { cwd: this.o.repo, env: baseEnv({ ...extra, ...TRUSTED_GIT_ENV, GIT_TERMINAL_PROMPT: "0" }) });
  }
}

function gitError(what: string, r: ExecResult): Error {
  return new Error(`local forge: git ${what} failed (${r.exit_code}): ${r.stderr.trim().slice(0, 300)}`);
}
