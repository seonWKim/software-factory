// The local merge (design 05-sources, Local items): `factory merge <id>` merges an item's local branch into the
// factory repo's local base branch, through the sandbox the controller already holds (as the merge check does),
// so core runs no git. Never automatic. With a forge selected, the merge queues one base push, which the
// controller's base push step brings to the remote later (`BaseSyncSandbox` here, `Forge.pushBase` there).

import type { SourceType } from "./types.js";
import type { Sandbox } from "../interfaces/sandbox.js";

/**
 * The source type of items filed in the factory itself: the store holds their thread and state, so they need no
 * adapter (issue #282), and they take the local broker and the local merge, never the forge (design 05-sources).
 */
export const LOCAL_SOURCE: SourceType = "local";

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
}

/**
 * `merged`: the base branch now contains the branch, at `sha` (`already`: it did before this call, so a repeat
 * changes nothing). `conflicts`: the conflicting file paths, sorted; nothing moved. `refused`: why nothing moved
 * (no such branch, a failing check, the base moved during the merge).
 */
export type LocalMergeResult =
  /**
   * `not_updated`: the checkouts of the base branch whose files were left as they were because they have
   * uncommitted changes (their HEAD is detached at the base before the merge); empty when there were none.
   */
  | { merged: true; sha: string; already: boolean; not_updated: string[] }
  | { merged: false; conflicts: string[] }
  | { merged: false; refused: string };

/**
 * A sandbox that can merge locally: `mergeLocal` writes the merge commit in the factory repo's object store
 * (never the owner's checkout), runs the checks on it in a temporary worktree, and moves only
 * `refs/heads/<base_ref>`, conditionally on the base it merged.
 */
export type LocalMergeSandbox = Sandbox & { mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> };

/** What the base push step asks the sandbox: bring the remote base into the local one before the push. */
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
 * remote base moved and does not merge cleanly into the local one (the paths, sorted); nothing moved.
 */
export type BaseSyncResult =
  | { synced: true; local: string; remote: string; contains: boolean; not_updated: string[] }
  | { synced: false; conflicts: string[] };

/**
 * A sandbox that can bring the remote base into the local one: fetches only the remote base branch, and when it
 * moved and is not an ancestor of the local base, merges it into the local base (objects and one conditional ref
 * update, as the local merge). Throws on a failed fetch or a base that moved under it: the caller retries.
 */
export type BaseSyncSandbox = Sandbox & { syncBase(spec: BaseSyncSpec): Promise<BaseSyncResult> };

export function canSyncBase(sandbox: Sandbox | undefined): sandbox is BaseSyncSandbox {
  return !!sandbox && typeof (sandbox as Partial<BaseSyncSandbox>).syncBase === "function";
}

export function canMergeLocal(sandbox: Sandbox | undefined): sandbox is LocalMergeSandbox {
  return !!sandbox && typeof (sandbox as Partial<LocalMergeSandbox>).mergeLocal === "function";
}
