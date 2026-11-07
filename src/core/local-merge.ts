// The local merge (design 05-sources, Local startup): `factory merge <id>` merges an item's local branch into the
// factory repo's local base branch, through the sandbox the controller already holds (as the merge check does),
// so core runs no git. Never a push, never the owner's checkout, never automatic.

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
 * (no such branch, the base branch checked out in a worktree, a failing check, the base moved during the merge).
 */
export type LocalMergeResult =
  | { merged: true; sha: string; already: boolean }
  | { merged: false; conflicts: string[] }
  | { merged: false; refused: string };

/**
 * A sandbox that can merge locally: `mergeLocal` writes the merge commit in the factory repo's object store
 * (never the owner's checkout), runs the checks on it in a temporary worktree, and moves only
 * `refs/heads/<base_ref>`, conditionally on the base it merged.
 */
export type LocalMergeSandbox = Sandbox & { mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> };

export function canMergeLocal(sandbox: Sandbox | undefined): sandbox is LocalMergeSandbox {
  return !!sandbox && typeof (sandbox as Partial<LocalMergeSandbox>).mergeLocal === "function";
}
