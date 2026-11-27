// The local merge (design 05-sources, Local items): `factory merge <id>` merges an item's local branch into the
// factory repo's local base branch, through the sandbox the controller already holds (as the merge check does),
// so core runs no git. Never automatic. With a forge that pushes a base, the merge queues one base push, which
// outbound's `local` target brings to the remote later (`BaseSyncSandbox` here, `Forge.pushBase` there).

import type { SourceRef, SourceType, WorkItem } from "./types.js";
import type { NewThreadDelivery, ThreadLinkField } from "../interfaces/factory-store.js";
import type { Forge } from "../interfaces/forge.js";
import type { Sandbox } from "../interfaces/sandbox.js";

// What follows a merge: the restart command and the merge reply's run hint (design 04-gate-commands, restart).
export * from "./restart.js";
// The auto merge step's tier rule and drop-back (design 03-risk), re-exported so the unit reads them through this module.
export { droppedBack, tierRule } from "./stats.js";
// The red-main check's runner and the revert's loop key (design 03-risk), read by the unit through this module too.
export { checkCommands, runChecks } from "./checks.js";
export { runKey } from "./policy.js";

/**
 * The source type of items filed in the factory itself: the store holds their thread and state, so they need no
 * adapter (issue #282), and they take the local broker and the local merge, never the forge (design 05-sources).
 */
export const LOCAL_SOURCE: SourceType = "local";

/**
 * Where a factory message on `it`'s thread is delivered (issue #282): nowhere for a local item, whose thread is its
 * surface; else the item's own source, on `target` (e.g. the item's PR) when it is of that source's type.
 */
export function threadDelivery(it: Pick<WorkItem, "source">, target: SourceRef, link: ThreadLinkField | null = null): NewThreadDelivery | null {
  const type = it.source.type;
  return type === LOCAL_SOURCE ? null : { source_type: type, target: target.type === type ? target : it.source, link_field: link };
}

/** The command inbox name `factory merge <id>` stores; the controller applies it as the local merge. */
export const MERGE_COMMAND = "merge";

export interface LocalMergeSpec {
  /** The factory repo. */
  repo: string;
  /** The local base branch, e.g. "main": its ref is the only one that moves. */
  base_ref: string;
  /** The item's local branch, e.g. "factory/wi_…". */
  branch: string;
  /** The merge commit's message. */
  message: string;
  /** The merge commit's author and committer: the factory's git identity, never a person's display name. */
  identity: { name: string; email: string };
  /**
   * Argv commands run in order on the merge commit in a temporary worktree before the base moves: the install
   * command, then the checks (`repo.test_command` by default). One failing: nothing moves.
   */
  checks: readonly (readonly string[])[];
  /** Each check's time limit. */
  timeout_ms: number;
  /**
   * The merge queue's landing (RFC 0015 M8): the base its merge-check run checked the merged result on. A base at
   * another commit moves nothing (`base_moved`), so what lands is the tree that was checked.
   */
  expected_base?: string;
  /**
   * The merge queue's landing: the branch head its merge-check run merged. A branch at another commit (a commit made
   * on it during the check) moves nothing (`head_moved`), so no unchecked commit lands. A branch already in the base
   * is `already` first, whatever the base: a landing re-run after its base moved finds its own merge.
   */
  expected_head?: string;
}

/**
 * `merged`: the base branch now contains the branch, at `sha` (`already`: it did before this call, so a repeat
 * changes nothing). `conflicts`: the conflicting file paths, sorted; nothing moved. `refused`: why nothing moved
 * (no such branch, a failing check). `base_moved`: the base is not where it was checked, or it moved during the
 * merge; nothing moved and the merge is checked again.
 */
export type LocalMergeResult =
  /**
   * `not_updated`: the checkouts of the base branch whose files were left as they were because they have
   * uncommitted changes (their HEAD is detached at the base before the merge); empty when there were none.
   */
  | { merged: true; sha: string; already: boolean; not_updated: string[] }
  | { merged: false; conflicts: string[] }
  | { merged: false; refused: string }
  | { merged: false; base_moved: string }
  | { merged: false; head_moved: string };

/**
 * A sandbox that can merge locally: `mergeLocal` writes the merge commit in the factory repo's object store
 * (never the owner's checkout), runs the checks on it in a temporary worktree, and moves only
 * `refs/heads/<base_ref>`, conditionally on the base it merged.
 */
export type LocalMergeSandbox = Sandbox & {
  mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult>;
  /**
   * The paths `branch` conflicts in when merged into the local `base_ref` (sorted; empty: it merges cleanly), from
   * objects only; null when either branch is missing. A merge queue entry is refused at once on a conflict.
   */
  localConflicts(spec: { repo: string; base_ref: string; branch: string }): Promise<string[] | null>;
};

/** What the base push asks the sandbox: bring the remote base into the local one before the push. */
export interface BaseSyncSpec {
  repo: string;
  base_ref: string;
  /** The local merge the push is for: the remote already containing it means nothing is left to push. */
  merge_sha: string;
  /** The merge commit's message and identity, when the remote base moved and is merged into the local one. */
  message: string;
  identity: { name: string; email: string };
}

/**
 * `synced`: push `local` (the local base, a descendant of `remote`) conditionally on `remote`, the remote base the
 * sandbox read; `contains`: the remote base already contains the merge, so nothing is pushed. `conflicts`: the
 * remote base moved and does not merge cleanly into the local one (the paths, sorted), `remote` its commit, which
 * keys the reconcile item; nothing moved.
 */
export type BaseSyncResult =
  | { synced: true; local: string; remote: string; contains: boolean; not_updated: string[] }
  | { synced: false; conflicts: string[]; remote: string };

// The base reconcile's item key (design 05-sources, Base reconcile), kept beside the sandbox port its run uses.
export { reconcileOf, reconcileSourceId } from "../interfaces/sandbox.js";

/**
 * A sandbox that can bring the remote base into the local one: fetches only the remote base branch, and when it
 * moved and is not an ancestor of the local base, merges it into the local base (objects and one conditional ref
 * update, as the local merge). Throws on a failed fetch or a base that moved under it: the caller retries.
 */
export type BaseSyncSandbox = Sandbox & { syncBase(spec: BaseSyncSpec): Promise<BaseSyncResult> };

export function canSyncBase(sandbox: Sandbox | undefined): sandbox is BaseSyncSandbox {
  return !!sandbox && typeof (sandbox as Partial<BaseSyncSandbox>).syncBase === "function";
}

/**
 * `pulled`: the local base was an ancestor of the remote one and now is the remote base (`from` its old commit).
 * `current`: the local base already contains the remote one; nothing moved. `diverged`: the local base has commits
 * the remote has not (a local merge whose push is pending) and the remote moved too; nothing moved, and that
 * merge's base push merges the two.
 */
export type BasePullResult =
  | { pulled: true; from: string; to: string; not_updated: string[] }
  | { pulled: false; local: string; remote: string; diverged: boolean };

/**
 * A sandbox that can bring the local base up to the remote one after a merge made on the forge (the base
 * pull decision): fetches only the remote base branch and fast-forwards the local base to it with one conditional ref
 * update, only when the local base is its ancestor. Never merges, never pushes. Throws on a failed fetch or a base
 * that moved under it: the caller retries.
 */
export type BasePullSandbox = Sandbox & { pullBase(spec: { repo: string; base_ref: string }): Promise<BasePullResult> };

export function canPullBase(sandbox: Sandbox | undefined): sandbox is BasePullSandbox {
  return !!sandbox && typeof (sandbox as Partial<BasePullSandbox>).pullBase === "function";
}

/**
 * A sandbox that reads the factory repo's local branches whatever it fetches (design §5 Merge conflict): with a
 * forge selected, the controller's base read is the remote's, so a local item's merge check and its automatic
 * resolve key read the local base and branch here. No fetch, no network call.
 */
export type LocalReadSandbox = Sandbox & {
  /** The commit of the factory repo's local branch `branch`, or null when there is none. */
  localBranch(spec: { repo: string; branch: string }): Promise<string | null>;
};

export function canReadLocal(sandbox: Sandbox | undefined): sandbox is LocalReadSandbox {
  return !!sandbox && typeof (sandbox as Partial<LocalReadSandbox>).localBranch === "function";
}

/**
 * A sandbox that reads which files changed between two commits of the factory repo, from objects only (no fetch, no
 * checkout): the red-main check runs the UI check only when the merge's own change touches its paths (design 03-risk).
 */
export type ChangedFilesSandbox = Sandbox & {
  /** The paths changed from `from` (absent: `to`'s first parent) to `to`, sorted; null when either commit cannot be read. */
  localChangedFiles(spec: { repo: string; to: string; from?: string }): Promise<string[] | null>;
};

export function canReadChangedFiles(sandbox: Sandbox | undefined): sandbox is ChangedFilesSandbox {
  return !!sandbox && typeof (sandbox as Partial<ChangedFilesSandbox>).localChangedFiles === "function";
}

/** What the red-main revert asks the sandbox (design 03-risk): revert one automatic merge at the tip of the local base. */
export interface LocalRevertSpec {
  repo: string;
  /** The local base branch: it moves only from `merge_sha` to the revert commit. */
  base_ref: string;
  /** The merge commit to revert: the base's tip. */
  merge_sha: string;
  /** The merge's first parent, the base the red-main check found green: anything else reverts nothing. */
  parent: string;
  /** The item's local branch: put back on top of the revert when it is at the merge's second parent. */
  branch: string;
  /** The factory's git identity, never a person's. */
  identity: { name: string; email: string };
}

/**
 * `reverted`: the base is at `sha`, a commit whose tree is `parent`'s, with git's message `This reverts commit
 * <merge_sha>` (`already`: it was before this call, so a repeat changes nothing); `branch_reapplied`: the item's
 * branch was moved to a commit on top of it that applies the change again. `refused`: nothing moved, and why (the
 * base is not at the merge, or the merge's first parent is not `parent`).
 */
export type LocalRevertResult =
  | { reverted: true; sha: string; already: boolean; branch_reapplied: boolean }
  | { reverted: false; refused: string };

/**
 * A sandbox that can revert an automatic merge on the local base (objects and one conditional ref update, as the
 * local merge): no checkout, no hook, no push. Optional, checked at runtime (`canRevertLocal`), so a sandbox
 * without it keeps today's stop.
 */
export type LocalRevertSandbox = Sandbox & { revertLocal(spec: LocalRevertSpec): Promise<LocalRevertResult> };

export function canRevertLocal(sandbox: Sandbox | undefined): sandbox is LocalRevertSandbox {
  return !!sandbox && typeof (sandbox as Partial<LocalRevertSandbox>).revertLocal === "function";
}

export function canMergeLocal(sandbox: Sandbox | undefined): sandbox is LocalMergeSandbox {
  const s = sandbox as Partial<LocalMergeSandbox> | undefined;
  return !!s && typeof s.mergeLocal === "function" && typeof s.localConflicts === "function";
}

/**
 * Whether the sandbox can append to a file on the local base (design 07-design-learnings): it merges locally, reads
 * local branches and files, and commits one file on a new local branch, with no checkout and no network call.
 */
export function canAppendLocal(sandbox: Sandbox | undefined): boolean {
  return canMergeLocal(sandbox) && canReadLocal(sandbox) && typeof sandbox.readLocalFile === "function" && typeof sandbox.commitNewBranch === "function";
}

/**
 * The controller's forge and link reader (issue #273; design 05-sources, Local items): a selected forge is both.
 * With none, `local` (the local forge compose builds) reads links, and is the forge too only when it pushes the base
 * (`merge_queue.push_base` and an origin), so the default stays no forge, no push row and no remote call.
 */
export function forgeRoles(selected: Forge | null, local: Forge): { forge: Forge | null; links: Forge } {
  if (selected) return { forge: selected, links: selected };
  return { forge: local.pushBase ? local : null, links: local };
}
