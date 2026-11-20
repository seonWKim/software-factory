// The item page's Changes tab and the Merge check card's Re-check (design 09-dashboard-item), and the Needs you overlap
// note (design 09-dashboard-tasks). Changes read git objects already in the factory repo through the sandbox's trusted
// readChanges (no fetch, no forge call), for the head the merge check stored, else the item's last recorded head; every
// path and every diff passes the EgressScanner (channel `ui`) before it leaves. Re-check only deletes the item's stored
// merge check row (FactoryStore.clearMergeCheck): no git, no forge call and no item change in the request; the controller's
// next merge check stores a new result (design 05-merge-conflict). The overlap note reads only the stored pr_files.

import { phaseOf } from "../core/phase.js";
import type { WorkItem, WorkItemId } from "../core/types.js";
import type { MergeCheck } from "../interfaces/factory-store.js";
import type { ChangesRead, ChangesSpec } from "../interfaces/sandbox.js";
import type { UiDeps } from "./deps.js";
import { Withholder } from "./withhold.js";

/** Decision 1: a file's diff loads up to 256 KiB, then a `truncated` note. */
export const DIFF_MAX_BYTES = 256 * 1024;

/** The sandbox's readChanges with the factory repo and its base branch bound (compose.ts). */
export type UiChanges = (spec: Pick<ChangesSpec, "head_sha" | "path" | "max_bytes">) => Promise<ChangesRead>;

/** A route's result; server.ts adds the headers. */
interface Result {
  status: number;
  value: unknown;
}

const err = (status: number, error: string): Result => ({ status, value: { error } });
const CHANGES = /^\/api\/v1\/items\/([^/]+)\/changes$/;
const RECHECK = /^\/api\/v1\/items\/([^/]+)\/merge-check\/recheck$/;

/** The raw item id of a Changes read's path, else null. */
export function changesPathId(pathname: string): string | null {
  return CHANGES.exec(pathname)?.[1] ?? null;
}

/** The raw item id of a Re-check POST's path (a query string ignored), else null. */
export function recheckPathId(rawUrl: string | undefined): string | null {
  return RECHECK.exec((rawUrl ?? "/").split(/[?#]/, 1)[0]!)?.[1] ?? null;
}

/** The item a raw path id names, or null (a malformed id or none stored). */
async function itemOf(d: UiDeps, rawId: string): Promise<WorkItem | null> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  return d.store.getWorkItem(id as WorkItemId);
}

/** The head the Changes tab reads: the stored merge check's head, else the item's last recorded head; null: no branch. */
export function changesHead(it: WorkItem, check: MergeCheck | null): string | null {
  return check?.head_sha ?? it.last_head_sha;
}

/**
 * GET /api/v1/items/:id/changes: each changed file with its counts, and with `?path=` that file's diff (cut at
 * DIFF_MAX_BYTES, `truncated` then). A withheld path or diff reads as the withheld marker; its row stays.
 */
export async function readItemChanges(d: UiDeps, rawId: string, path: string | null): Promise<Result> {
  const it = await itemOf(d, rawId);
  if (!it) return err(404, "No such work item.");
  const head = changesHead(it, await d.store.getMergeCheck(it.id));
  if (!d.changes || head === null) return err(404, "This item has no branch to show.");
  let read: ChangesRead;
  try {
    read = await d.changes({ head_sha: head, ...(path === null ? {} : { path, max_bytes: DIFF_MAX_BYTES }) });
  } catch {
    return err(404, "The branch's commits are not in the factory repo.");
  }
  const w = new Withholder(d.scanner);
  const files = [];
  for (const f of read.files) files.push({ path: (await w.plain(f.path, { channel: "ui" })).text, added: f.added, removed: f.removed });
  const value: Record<string, unknown> = { as_of: d.clock.now().toISOString(), head_sha: head, base_sha: read.base?.sha ?? null, files };
  if (path !== null) {
    if (!read.files.some((f) => f.path === path) || read.patch === null) return err(404, "No such changed file.");
    const diff = await w.plain(read.patch.text, { channel: "ui" });
    value.file = { path: (await w.plain(path, { channel: "ui" })).text, diff: diff.text, withheld: diff.withheld, truncated: read.patch.truncated };
  }
  return { status: 200, value };
}

/** POST /api/v1/items/:id/merge-check/recheck (behind server.ts's write guards): deletes the item's stored merge check. */
export async function recheckMergeCheck(d: UiDeps, rawId: string): Promise<Result> {
  const it = await itemOf(d, rawId);
  if (!it) return err(404, "No such work item.");
  return { status: 200, value: { work_item_id: it.id, cleared: await d.store.clearMergeCheck(it.id) } };
}

/** When the trusted base's last commit was made; null without the read, without a base, or on a git error. */
export async function baseCommittedAt(d: UiDeps): Promise<string | null> {
  if (!d.changes) return null;
  return (await d.changes({}).catch(() => null))?.base?.committed_at ?? null;
}

/**
 * The local merge check of a ready-to-merge item (null for any other item): `mergeable` or `conflicts` from its
 * stored result, or `checking` while it has none, or while the result is for an older head than the one the
 * factory last recorded. File names pass `text`, each on its own.
 */
export async function mergeCheckRow(text: (v: string) => Promise<string | null>, it: WorkItem, m: MergeCheck | null) {
  // Waiting for a person's merge (core/phase.ts): the only state the local merge check runs on (design §5 Merge check).
  if (phaseOf(it) !== "merge_pending") return null;
  const current = m !== null && (it.last_head_sha === null || it.last_head_sha === m.head_sha);
  const conflicts: string[] = [];
  if (current) for (const f of m.conflicts) conflicts.push((await text(f))!);
  return {
    state: !current ? ("checking" as const) : m.mergeable ? ("mergeable" as const) : ("conflicts" as const),
    conflicts,
    head_sha: m?.head_sha ?? null,
    base_sha: m?.base_sha ?? null,
    checked_at: m?.checked_at ?? null,
  };
}

/** Whether a stored check is older than the base's last commit: the card then offers Re-check. */
export function needsRecheck(checked_at: string | null, base_at: string | null): boolean {
  return checked_at !== null && base_at !== null && Date.parse(checked_at) < Date.parse(base_at);
}

/** One other ready-to-merge item that shares changed files with a row's item, and the shared paths, sorted. */
export interface Overlap {
  id: WorkItemId;
  title: string | null;
  paths: string[];
}

/**
 * Decision 2: each ready-to-merge item's overlaps with the other ready-to-merge items, by exact path in their stored
 * pr_files. Items with none are left out. Paths and titles pass `text`.
 */
export async function overlapsOf(items: readonly WorkItem[], text: (v: string | null) => Promise<string | null>): Promise<Map<WorkItemId, Overlap[]>> {
  const ready = items.filter((it) => phaseOf(it) === "merge_pending" && (it.pr_files?.length ?? 0) > 0);
  const out = new Map<WorkItemId, Overlap[]>();
  for (const it of ready) {
    const mine = new Set(it.pr_files);
    for (const other of ready) {
      if (other.id === it.id) continue;
      const shared = [...new Set(other.pr_files!.filter((p) => mine.has(p)))].sort();
      if (shared.length === 0) continue;
      const paths = [];
      for (const p of shared) paths.push((await text(p))!);
      out.set(it.id, [...(out.get(it.id) ?? []), { id: other.id, title: await text(other.title || null), paths }]);
    }
  }
  return out;
}
