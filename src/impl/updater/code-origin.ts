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

/** A command in a code checkout, never throwing on its exit code. */
type Exec = (cmd: readonly string[]) => Promise<ExecResult>;

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
    private readonly exec: Exec,
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
    const count = await revListCount(this.exec, rev, origin);
    this.cache = { rev, origin, count };
    return count;
  }
}

/** `git rev-list --count <from>..<to>`: the commits in `to` that `from` lacks; null when git fails or says no number. */
export async function revListCount(exec: Exec, from: string, to: string): Promise<number | null> {
  const r = await exec(["git", "rev-list", "--count", `${from}..${to}`]);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.exit_code === 0 && Number.isInteger(n) ? n : null;
}

/** The commit subjects an update note lists at most (design 09-dashboard-shell). */
export const UPDATE_SUBJECTS = 20;

/** What a factory update brought: its commit count (null: git could not say) and the newest subjects. */
export interface UpdateChanges {
  count: number | null;
  subjects: string[];
}

/**
 * The commits between the revision a new child replaced and its own (design 08-self-update, `previous_rev..rev`):
 * the count and at most UPDATE_SUBJECTS subjects, newest first. The last pair is kept, so the dashboard's poll runs
 * git once per update; a git failure gives no count and no subjects.
 */
export function updateChanges(exec: Exec): (from: string, to: string) => Promise<UpdateChanges> {
  let last: { from: string; to: string; changes: UpdateChanges } | null = null;
  return async (from, to) => {
    if (last?.from === from && last.to === to) return last.changes;
    const count = await revListCount(exec, from, to);
    const log = count === null ? null : await exec(["git", "log", "--format=%s", `--max-count=${UPDATE_SUBJECTS}`, `${from}..${to}`]);
    const subjects = log?.exit_code === 0 ? log.stdout.split("\n").filter((l) => l.trim() !== "") : [];
    last = { from, to, changes: { count, subjects } };
    return last.changes;
  };
}
