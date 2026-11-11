// Per-merge evaluations (design 06-measurement): the one write, made inside the merge's transition, and the read,
// kept out of sql-factory-store.ts so that file stays within its line budget. Store data only: no sync plugin.

import { type MergeEvaluation, noVerdicts } from "../../../core/merge-evaluation.js";
import type { Tier, Timestamp, VerdictKind, WorkItem, WorkItemId } from "../../../core/types.js";
import type { SqlExecutor, SqlValue } from "../../../state/index.js";

/**
 * The evaluation of `item`'s merge as `merge_sha`, inserted only when none is stored for that (item, merge_sha):
 * a second run, or another replica, inserts nothing. True when it inserted. The primary key backs the check.
 */
export async function recordMergeEvaluation(tx: SqlExecutor, item: WorkItem, merged_by: string, at: Timestamp): Promise<boolean> {
  const n = await tx.run(
    `INSERT INTO controller_merge_evaluations (work_item_id, merge_sha, tier, merged_by, token_cost, merged_at)
     SELECT ?, ?, ?, ?, ?, ? FROM controller_work_items w WHERE w.id = ?
       AND NOT EXISTS (SELECT 1 FROM controller_merge_evaluations e WHERE e.work_item_id = ? AND e.merge_sha = ?)`,
    [item.id, item.merge_sha, item.tier, merged_by, item.token_cost, at, item.id, item.id, item.merge_sha],
  );
  return n > 0;
}

/** Records the merge when this transition made it: the item moved to CLOSED, completed, with a merge commit. */
export async function onMergeTransition(tx: SqlExecutor, before: WorkItem, after: WorkItem, merged_by: string, at: Timestamp): Promise<void> {
  const merged = after.stage === "CLOSED" && after.close_reason === "completed" && after.merge_sha !== null;
  if (merged && before.stage !== "CLOSED") await recordMergeEvaluation(tx, after, merged_by, at);
}

/** Every stored evaluation merged at or after `since` (null: all), oldest first, with what followed each merge. */
export async function listMergeEvaluations(db: SqlExecutor, since: Timestamp | null): Promise<MergeEvaluation[]> {
  const where = since === null ? "" : " WHERE e.merged_at >= ?";
  const params: SqlValue[] = since === null ? [] : [since];
  const rows = await db.all(
    `SELECT e.*, w.project, w.title FROM controller_merge_evaluations e JOIN controller_work_items w ON w.id = e.work_item_id
     ${where} ORDER BY e.merged_at, e.work_item_id`,
    params,
  );
  if (rows.length === 0) return [];
  // The same window as a subquery: no bound list of ids, however many merges it holds.
  const merged = `SELECT e.work_item_id FROM controller_merge_evaluations e${where}`;
  const changes = await db.all(
    `SELECT work_item_id, reason, COUNT(*) AS n FROM controller_state_changes
     WHERE work_item_id IN (${merged}) AND reason IN ('reverted', 'fixed_forward') GROUP BY work_item_id, reason`,
    params,
  );
  const verdicts = await db.all(
    `SELECT work_item_id, verdict, COUNT(*) AS n FROM controller_verdicts WHERE work_item_id IN (${merged}) GROUP BY work_item_id, verdict`,
    params,
  );
  const count = (id: string, reason: string) => Number(changes.find((c) => c.work_item_id === id && c.reason === reason)?.n ?? 0);
  return rows.map((r) => {
    const id = String(r.work_item_id);
    const kinds = noVerdicts();
    for (const v of verdicts) if (v.work_item_id === id) kinds[v.verdict as VerdictKind] = Number(v.n);
    return {
      work_item_id: id as WorkItemId, project: String(r.project), merge_sha: String(r.merge_sha),
      tier: r.tier === null ? null : (Number(r.tier) as Tier), merged_by: String(r.merged_by),
      merged_at: String(r.merged_at) as Timestamp, token_cost: Number(r.token_cost),
      title: r.title == null ? null : String(r.title),
      reverted: count(id, "reverted"), fixed_forward: count(id, "fixed_forward"), verdicts: kinds,
    };
  });
}
