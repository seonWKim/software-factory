// Which revision the git-worktree updater follows, and how far the running one is behind it (design
// 08-self-update): the local base branch (self-hosting, no GitHub plugin), origin/<base> fetched every poll
// (self-hosting with GitHub), or origin/main of a separate code checkout fetched once per code update interval.

import type { Logger } from "../../core/log.js";
import type { ExecResult } from "../../interfaces/sandbox.js";

/** The branch a separate code checkout follows on its origin: the factory's own, never the project's repo.base_branch. */
export const CODE_BASE_BRANCH = "main";

export interface CodeOriginOptions {
  baseBranch: string;
  /** Follow `refs/heads/<baseBranch>` with no fetch: self-hosting with no GitHub plugin selected (design 05-sources). */
  local?: boolean;
  /**
   * A code checkout that is not the project repository: `git fetch` at most once per this many ms
   * (`updater.code_update_interval_ms`); the calls between read only the local origin ref. A failed fetch is logged
   * and tried again one interval later. Absent: a fetch on every call (or none with `local`), and no `behind`.
   */
  fetchIntervalMs?: number;
  log: Logger;
}

export class CodeOrigin {
  /** When the last fetch was tried (ms), and origin's revision after the last one that succeeded. */
  private fetchedAt: number | null = null;
  private checked: string | null = null;
  /** The last `rev-list --count`, so a poll with nothing new runs no git for `behind`. */
  private cache: { rev: string; origin: string; count: number | null } | null = null;

  constructor(
    private readonly o: CodeOriginOptions,
    /** `git <args>` in the code checkout: its stdout, or a throw on a non-zero exit. */
    private readonly git: (args: string[]) => Promise<string>,
    /** A command in the code checkout, never throwing on its exit code. */
    private readonly exec: (cmd: readonly string[]) => Promise<ExecResult>,
    /** The owner's Clock, in ms (the updater's; this class reads no clock of its own). */
    private readonly now: () => number,
  ) {}

  /** Whether the status file carries `behind`: only for a separate code checkout. */
  get reportsBehind(): boolean {
    return this.o.fetchIntervalMs !== undefined;
  }

  /** The revision to run: the local base branch (`local`), else origin/<base> after a fetch when one is due. */
  async revision(): Promise<string> {
    const { baseBranch, fetchIntervalMs: every, log } = this.o;
    if (this.o.local) return (await this.git(["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`])).trim();
    const fetchArgs = ["fetch", "--quiet", "origin", baseBranch];
    let fetched = false;
    if (every === undefined) await this.git(fetchArgs);
    else {
      const now = this.now();
      if (this.fetchedAt === null || now - this.fetchedAt >= every) {
        this.fetchedAt = now;
        fetched = await this.git(fetchArgs).then(
          () => true,
          (err: unknown) => {
            log.warn("git fetch of the code checkout failed; the running version stays, next try in one interval", {
              error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
              retry_in_ms: every,
            });
            return false;
          },
        );
      }
    }
    const origin = (await this.git(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`])).trim();
    if (fetched) this.checked = origin;
    return origin;
  }

  /** Commits `rev` is behind origin as of the last successful fetch; null before one, with no `rev`, or unknown. */
  async behind(rev: string | null): Promise<number | null> {
    const origin = this.checked;
    if (rev === null || origin === null) return null;
    if (rev === origin) return 0;
    const c = this.cache;
    if (c?.rev === rev && c.origin === origin) return c.count;
    const r = await this.exec(["git", "rev-list", "--count", `${rev}..${origin}`]);
    const n = Number.parseInt(r.stdout.trim(), 10);
    const count = r.exit_code === 0 && Number.isInteger(n) ? n : null;
    this.cache = { rev, origin, count };
    return count;
  }
}
