// The base push reads (design 05-sources, Local items; RFC 0015 M8): outbound's `push_base` actions, their tries
// their batch's, kept out of sql-factory-store.ts so that file stays within its line budget. Read-only.

import type { WorkItemId } from "../../../core/types.js";
import type { BasePush, BasePushBacklog } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";

export async function getBasePush(db: SqlDriver, work_item_id: WorkItemId): Promise<BasePush | null> {
  const [row] = await db.all(
    "SELECT seq, args, delivered_ref FROM outbound_actions WHERE action = 'push_base' AND work_item_id = ? ORDER BY seq DESC LIMIT 1", [work_item_id],
  );
  if (!row) return null;
  const [batch] = await db.all(
    "SELECT b.attempts, b.last_error FROM outbound_batch_intents i JOIN outbound_batches b ON b.id = i.batch_id WHERE i.intent_id = ?", [`act_${Number(row.seq)}`],
  );
  const args = JSON.parse(String(row.args)) as { base_ref: string; merge_sha: string };
  const done = row.delivered_ref === null ? null : (JSON.parse(String(row.delivered_ref)) as { pushed?: string; conflicts?: string[] });
  return {
    base_ref: args.base_ref, merge_sha: args.merge_sha,
    attempts: Number(batch?.attempts ?? 0), last_error: (batch?.last_error as string | null | undefined) ?? null,
    outcome: done === null ? null : done.pushed !== undefined ? "pushed" : "conflict", pushed_sha: done?.pushed ?? null,
  };
}

export async function listBasePushBacklogs(db: SqlDriver): Promise<BasePushBacklog[]> {
  // A pushed outcome is stored as `{"pushed":…}` (local-git.ts): the rows after the newest one of any base, none
  // of them pushed, each pending or a conflict.
  const rows = await db.all(
    `SELECT seq, args, delivered_ref FROM outbound_actions WHERE action = 'push_base' AND seq > COALESCE(
       (SELECT MAX(seq) FROM outbound_actions WHERE action = 'push_base' AND delivered_ref LIKE '{"pushed"%'), 0) ORDER BY seq`,
  );
  const bases = new Map<string, BasePushBacklog>();
  for (const row of rows) {
    const base = (JSON.parse(String(row.args)) as { base_ref: string }).base_ref;
    const b = bases.get(base) ?? { base_ref: base, waiting: 0, conflicts: null };
    b.waiting++;
    // In order, so the newest delivered conflict names the files.
    if (row.delivered_ref !== null) b.conflicts = (JSON.parse(String(row.delivered_ref)) as { conflicts?: string[] }).conflicts ?? [];
    bases.set(base, b);
  }
  return [...bases.values()];
}
