// The local merge check (design §5 Merge check, issue #248): for each item waiting for a human merge, git computes
// whether its branch (a PR's, or a local item's when the sandbox reads local refs) still merges cleanly into the
// newest base, in the factory repo's object store, never in a checkout. The result is stored per item (one latest row), so every replica and the dashboard read the same one.
// The dashboard only reads that row; nothing here runs on a request.

import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore, NewMergeCheck } from "../interfaces/factory-store.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { WorkItem, WorkItemId } from "./types.js";

/** Ready-to-merge items one merge check step looks at. */
export const MERGE_CHECK_BATCH = 50;

export interface MergeCheckDeps {
  store: FactoryStore;
  sandbox: MergeCheckSandbox;
  clock: Clock;
}

/** Where to check: the factory repo, its base branch, the factory branch prefix, and how often to fetch. */
export interface MergeCheckTarget {
  repo: string;
  base_ref: string;
  branch_prefix: string;
  poll_interval_ms: number;
}

/** A fresh conflict: the item and the result about to be stored (its head and base sha). */
export type OnConflict = (item: WorkItem, check: NewMergeCheck) => Promise<void>;

/** A sandbox that can run the check. */
export type MergeCheckSandbox = Sandbox & Required<Pick<Sandbox, "fetchBranch" | "mergeCheck">>;

/** Whether the sandbox can run the check: it has fetchBranch and mergeCheck. */
export function canMergeCheck(sandbox: Sandbox | undefined): sandbox is MergeCheckSandbox {
  return !!sandbox && typeof sandbox.fetchBranch === "function" && typeof sandbox.mergeCheck === "function";
}

/**
 * Runs the check step. The fetches are throttled in-process: the base at most once per `poll_interval_ms` and an
 * item's head at the same fetch (or once when the item is first seen), however often `step` is called. That
 * throttle only saves network calls; another replica that lacks it fetches for itself. The git merge check runs
 * once per (item, head sha, base sha): a stored result for the same pair is the cache.
 */
export class MergeChecker {
  private fetchedAt = -Infinity;
  private base: string | null = null;
  /** Each item's head as of the last fetch; null: origin has no such branch. */
  private readonly heads = new Map<WorkItemId, string | null>();

  constructor(private readonly d: MergeCheckDeps) {}

  /**
   * One step over `items` (the caller passes only ready-to-merge factory items). Calls `onConflict` before it
   * stores a new conflict, so a crash in between checks again next time instead of losing the update or resolve run.
   */
  async step(items: readonly WorkItem[], t: MergeCheckTarget, onConflict: OnConflict): Promise<void> {
    if (items.length === 0) return;
    const now = this.d.clock.now().getTime();
    const due = this.base === null || now - this.fetchedAt >= t.poll_interval_ms;
    if (due) {
      this.base = await this.d.sandbox.updateBase({ repo: t.repo, base_ref: t.base_ref });
      this.fetchedAt = now;
      this.heads.clear();
    }
    const base = this.base!;
    for (const id of [...this.heads.keys()]) if (!items.some((it) => it.id === id)) this.heads.delete(id);
    for (const it of items) {
      if (!this.heads.has(it.id)) {
        this.heads.set(it.id, await this.d.sandbox.fetchBranch({ repo: t.repo, branch: `${t.branch_prefix}${it.id}` }));
      }
      await this.check(it, t, this.heads.get(it.id) ?? null, base, onConflict);
    }
  }

  /**
   * One step over local items (no PR) when the sandbox's fetches read the remote (a forge selected; design §5 Merge
   * conflict): the local base and each item's local branch are read with `read` (the factory repo's own refs, no
   * fetch, so no throttle), then checked as `step` checks a PR's branch.
   */
  async stepLocal(items: readonly WorkItem[], t: MergeCheckTarget, read: (branch: string) => Promise<string | null>, onConflict: OnConflict): Promise<void> {
    if (items.length === 0) return;
    const base = await read(t.base_ref);
    if (base === null) return;
    for (const it of items) await this.check(it, t, await read(`${t.branch_prefix}${it.id}`), base, onConflict);
  }

  /** The git check of `it` at `head` on `base`, once per pair (the stored result is the cache); none with no head. */
  private async check(it: WorkItem, t: MergeCheckTarget, head: string | null, base: string, onConflict: OnConflict): Promise<void> {
    if (head === null) return;
    const stored = await this.d.store.getMergeCheck(it.id);
    if (stored && stored.head_sha === head && stored.base_sha === base) return;
    const r = await this.d.sandbox.mergeCheck({ repo: t.repo, head_sha: head, base_sha: base });
    const check: NewMergeCheck = { work_item_id: it.id, mergeable: r.mergeable, conflicts: r.conflicts, head_sha: head, base_sha: base };
    if (!r.mergeable) await onConflict(it, check);
    await this.d.store.recordMergeCheck(check);
  }
}
