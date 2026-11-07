// The local merge (design 05-sources, Local startup): `factory merge <id>` merges an item's local branch into the
// factory repo's local base branch, through the sandbox the controller already holds (as the merge check does),
// so core runs no git. Never a push, never the owner's checkout, never automatic.
// Local items beside a forge (design 05-sources, issue #333): a local item uses the local broker and sandbox, chosen
// by its source type, also when a forge plugin is selected.

import type { CheckResult } from "./checks.js";
import type { SourceType, WorkItem } from "./types.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { ToolBroker } from "../interfaces/tool-broker.js";

/** The command inbox name `factory merge <id>` stores; the controller applies it as the local merge. */
export const MERGE_COMMAND = "merge";

/** The source type of items filed locally (CLI, local UI): their branch stays local and `factory merge` merges it. */
export const LOCAL_SOURCE_TYPE: SourceType = "local";

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
   * The commands the merged result must pass before the base moves (the controller: `repo.install_command`, then
   * `repo.test_command`), each with `timeout_ms`, run in order in a temporary worktree at the merge commit, never in
   * the live checkout. The first failure stops them and nothing moves. Absent: none run.
   */
  checks?: { commands: readonly (readonly string[])[]; timeout_ms: number };
}

/**
 * `merged`: the base branch now contains the branch, at `sha` (`already`: it did before this call, or another
 * merge of the same branch moved it first, so a repeat changes nothing). `conflicts`: the conflicting file paths,
 * sorted; nothing moved. `failed`: the check the merged result failed; nothing moved. `refused`: why nothing moved
 * (no such branch, the base branch checked out in a worktree, the base moved during the merge).
 */
export type LocalMergeResult =
  | { merged: true; sha: string; already: boolean }
  | { merged: false; conflicts: string[] }
  | { merged: false; failed: CheckResult }
  | { merged: false; refused: string };

/**
 * A sandbox that can merge locally: `mergeLocal` writes the merge commit in the factory repo's object store
 * (no checkout of the live repo) and moves only `refs/heads/<base_ref>`, conditionally on the base it merged.
 */
export type LocalMergeSandbox = Sandbox & { mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> };

export function canMergeLocal(sandbox: Sandbox | undefined): sandbox is LocalMergeSandbox {
  return !!sandbox && typeof (sandbox as Partial<LocalMergeSandbox>).mergeLocal === "function";
}

/**
 * The broker and sandbox local items use while a forge plugin is selected: the `local` broker and the selected
 * sandbox in its local mode (no origin fetch, the local base), built by compose beside the selected ones.
 */
export interface LocalParts {
  broker: ToolBroker;
  sandbox: Sandbox;
}

/**
 * The local parts `item` runs with: `local` for an item of source type `local`, null for every other item (it keeps
 * the selected broker and sandbox, so a forge item still pushes and opens its PR through the forge's broker). Also
 * null when `local` is absent: no forge plugin is selected, so the selected parts are the local ones already.
 */
export function localPartsFor(item: Pick<WorkItem, "source">, local: LocalParts | undefined): LocalParts | null {
  return local && item.source.type === LOCAL_SOURCE_TYPE ? local : null;
}
