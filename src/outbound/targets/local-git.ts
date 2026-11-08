// The `local` target's git writes (RFC 0015 §7, M8): the merge queue's landing (`merge`) and the base push that
// follows it (`push_base`) leave through outbound, from the factory repo of the host the destination names
// (`git:<host>:<base>`). Both go through `LocalGit`, built here from the sandbox (the factory repo's merge and the
// remote base's fetch) and the forge (the push, which holds the credentials), the target's dependency (TargetDeps).
// A delivery's outcome is its `delivered_ref` (JSON, at most 1024 characters), which the controller applies on
// DeliveryCompleted. A thrown error is a failure outbound retries with its batch's backoff.

import type { ActionRow } from "../intents.js";
import type { TargetDeps } from "./target.js";

export interface GitMergeSpec {
  readonly base_ref: string;
  readonly branch: string;
  readonly message: string;
  /** The base the merge-check run checked on: a base at another commit moves nothing (`moved`). */
  readonly expected_base: string;
  /** The branch head the check merged; null when not known. A branch at another commit moves nothing (`moved`). */
  readonly expected_head: string | null;
}

/**
 * `merged`: the base contains the branch at `sha` (`already`: it did before, so a repeated delivery changes
 * nothing). `moved`: the base or the branch is not where the check left it, or they no longer merge cleanly;
 * nothing moved and the entry is checked again. `refused`: why nothing moved (no such branch, no merge here).
 */
export type GitMergeResult =
  | { readonly merged: true; readonly sha: string; readonly already: boolean; readonly not_updated: readonly string[] }
  | { readonly merged: false; readonly moved: true }
  | { readonly merged: false; readonly refused: string };

export interface GitBasePushSpec {
  readonly base_ref: string;
  /** The merge the push is for: a remote base that already contains it needs no push. */
  readonly merge_sha: string;
  /** The commit message when the remote base moved and is merged into the local one first. */
  readonly message: string;
}

/** `pushed`: the remote base is at `sha` (it contains the merge). `conflicts`: it moved and does not merge cleanly. */
export type GitBasePushResult = { readonly pushed: string } | { readonly conflicts: readonly string[] };

/** The factory repo's git writes, as the `local` target makes them. */
export interface LocalGit {
  merge(spec: GitMergeSpec): Promise<GitMergeResult>;
  /** Brings the remote base into the local one and pushes it; null when the project has no remote to push to. */
  readonly pushBase: ((spec: GitBasePushSpec) => Promise<GitBasePushResult>) | null;
}

interface GitConfig {
  /** The factory repo. */
  readonly repo: string;
  /** The merge commits' author and committer: the factory's git identity, never a person's. */
  readonly identity: { name: string; email: string };
  readonly timeout_ms: number;
}

/**
 * What the `local` target needs of the sandbox, as a port (outbound names no sandbox plugin): the conditional merge
 * into the local base (`mergeLocal`), and the fetch and merge of the remote base before a push (`syncBase`). The
 * sandbox plugins that can merge locally implement both (design 05-sources, Local items).
 */
interface RepoSandbox {
  mergeLocal(spec: {
    repo: string; base_ref: string; branch: string; message: string; identity: { name: string; email: string };
    checks: readonly (readonly string[])[]; timeout_ms: number; expected_base?: string; expected_head?: string;
  }): Promise<{ merged: true; sha: string; already: boolean; not_updated: string[] } | { merged: false; refused?: string }>;
  syncBase?(spec: { repo: string; base_ref: string; merge_sha: string; message: string; identity: { name: string; email: string } }): Promise<
    { synced: true; local: string; remote: string; contains: boolean } | { synced: false; conflicts: string[] }
  >;
}

function repoSandbox(sandbox: unknown): RepoSandbox | null {
  return typeof (sandbox as Partial<RepoSandbox> | undefined)?.mergeLocal === "function" ? (sandbox as RepoSandbox) : null;
}

/**
 * The factory repo's merge and base push, or null when the sandbox cannot merge locally. The base push is null
 * without a forge that pushes a base (no remote: the solo default) or a sandbox that syncs one.
 */
export function localGit(sandbox: unknown, forge: TargetDeps["forge"], cfg: () => GitConfig): LocalGit | null {
  const repo = repoSandbox(sandbox);
  if (repo === null) return null;
  const sync = repo.syncBase?.bind(repo);
  return {
    async merge(spec) {
      const c = cfg();
      const r = await repo.mergeLocal({
        repo: c.repo, base_ref: spec.base_ref, branch: spec.branch, message: spec.message, identity: c.identity,
        checks: [], timeout_ms: c.timeout_ms,
        expected_base: spec.expected_base, ...(spec.expected_head !== null ? { expected_head: spec.expected_head } : {}),
      });
      if (r.merged) return { merged: true, sha: r.sha, already: r.already, not_updated: r.not_updated };
      if (r.refused !== undefined) return { merged: false, refused: r.refused };
      // The base or the branch moved, or they conflict now: the entry is checked again, and the check names them.
      return { merged: false, moved: true };
    },
    pushBase: !forge?.pushBase || !sync ? null : async (spec) => {
      const c = cfg();
      const s = await sync({ repo: c.repo, base_ref: spec.base_ref, merge_sha: spec.merge_sha, identity: c.identity, message: spec.message });
      if (!s.synced) return { conflicts: s.conflicts };
      if (s.contains) return { pushed: s.remote };
      await forge.pushBase!({ repo: c.repo, base_ref: spec.base_ref, sha: s.local, expected_sha: s.remote });
      return { pushed: s.local };
    },
  };
}

/** Whether `git` can deliver `row` here: a merge needs the factory repo, a base push its remote too. */
export function gitAccepts(git: LocalGit | null, row: ActionRow): boolean {
  if (row.action === "merge") return git !== null;
  return row.action === "push_base" && git?.pushBase != null;
}

/** Room left in `delivered_ref` (VARCHAR(1024)) for the lists and the reason. */
const MAX_TEXT = 700;

function capped(list: readonly string[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const s of list) {
    if ((n += s.length + 3) > MAX_TEXT) break;
    out.push(s);
  }
  return out;
}

/** Makes the merge or base push and returns its outcome as the action's `delivered_ref`. */
export async function deliverGit(git: LocalGit, row: ActionRow): Promise<{ url: null; ref: string }> {
  const a = row.args;
  if (row.action === "merge") {
    const r = await git.merge({
      base_ref: String(a.base_ref), branch: String(a.branch), message: String(a.message),
      expected_base: String(a.expected_base ?? ""), expected_head: a.expected_head === null || a.expected_head === undefined ? null : String(a.expected_head),
    });
    const out = r.merged ? { ...r, not_updated: capped(r.not_updated) } : "refused" in r ? { merged: false, refused: r.refused.slice(0, MAX_TEXT) } : r;
    return { url: null, ref: JSON.stringify(out) };
  }
  if (row.action !== "push_base" || !git.pushBase) throw new Error(`the local target does not deliver ${row.action}`);
  const r = await git.pushBase({ base_ref: String(a.base_ref), merge_sha: String(a.merge_sha), message: String(a.message) });
  return { url: null, ref: JSON.stringify("conflicts" in r ? { conflicts: capped(r.conflicts) } : r) };
}

/** A delivered merge's outcome; null for a row with none (not delivered yet). */
export function mergeOutcome(row: ActionRow): GitMergeResult | null {
  return row.delivered_ref === null ? null : (JSON.parse(row.delivered_ref) as GitMergeResult);
}

/** A delivered base push's outcome; null for a row with none. */
export function basePushOutcome(row: ActionRow): GitBasePushResult | null {
  return row.delivered_ref === null ? null : (JSON.parse(row.delivered_ref) as GitBasePushResult);
}
