// Two read models of the Health and Tasks pages, kept out of api.ts (at its line budget): the host sleep rows
// (design 09-health) and the unreviewed merges route (design 09-dashboard-tasks-needs). Store reads only; every
// stored text leaves through the caller's Withholder (`text`).

import type { HostSleep } from "../core/types.js";
import type { ApiDeps, ApiResult } from "./api.js";
import { mergeLinks } from "./list.js";
import { displayName } from "./names.js";

/** What these rows need of the API's per-request context. */
export interface RowCtx {
  d: Pick<ApiDeps, "store" | "displayNames">;
  text(value: string | null | undefined): Promise<string | null>;
  projectLabel(key: string): Promise<string>;
}

/**
 * Host sleeps as the API returns them: ids, a timestamp and a number. `runs` adds the held run's item, that item's
 * title and the run's status (each null when a lookup fails or the item has no title).
 */
export async function sleepRows(c: RowCtx, rows: readonly HostSleep[], runs = false) {
  const out = [];
  for (const h of rows) {
    const run = runs && h.run_id ? await c.d.store.getRun(h.run_id).catch(() => null) : null;
    const item = run ? await c.d.store.getWorkItem(run.work_item_id).catch(() => null) : null;
    const held = runs ? { work_item_id: run ? await c.text(run.work_item_id) : null, work_item_title: await c.text(item?.title || null), run_status: run?.status ?? null } : {};
    out.push({ worker_id: (await c.text(h.worker_id))!, woke_at: h.woke_at, gap_ms: h.gap_ms, run_id: h.run_id, ...held });
  }
  return out;
}

const MERGES_DEFAULT = 50;
const MERGES_MAX = 200;

/**
 * PRs that merged with no work item, newest first. The project is its stored label, never its key; `title` is the
 * PR's title as the forge gave it when the merge was recorded (null for a row recorded before titles were kept).
 */
export async function unreviewedMerges(c: RowCtx, params: URLSearchParams, now: Date): Promise<ApiResult> {
  let limit = MERGES_DEFAULT;
  const raw = params.get("limit");
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return { status: 400, value: { error: "limit must be a whole number from 1 to 200." } };
    limit = Math.min(Number(raw), MERGES_MAX);
  }
  const out = [];
  for (const m of await c.d.store.listUnreviewedMerges(limit)) {
    const label = await c.projectLabel(m.project);
    // Scan the whole sha, then shorten it: a cut-off secret would no longer match a rule.
    const sha = await c.text(m.merge_sha);
    out.push({
      project: await c.text(label),
      change_ref: m.change_ref, change_url: null, // no stored link (UnreviewedMerge carries only the ref): mergeLinks derives the PR's
      title: await c.text(m.title),
      ...(await mergeLinks(m.project, label, m.change_ref, (v) => c.text(v))),
      merge_sha: sha === m.merge_sha ? sha.slice(0, 7) : sha,
      merged_by: m.merger_id === null ? "unknown" : await c.text(m.merger_id),
      merged_by_name: m.merger_id === null ? null : await c.text(await displayName(c.d.displayNames, m.merger_id)),
      recorded_at: m.at,
    });
  }
  return { status: 200, value: { as_of: now.toISOString(), merges: out } };
}
