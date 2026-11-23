// The claim's coordination reads and writes (design 05-dependencies), apart from sql-factory-store.ts so the store
// stays within its line budget: what claimRun reads once for the cost check, the order rule's times and claim order
// (decided 2026-11-23: overlap holds go oldest first), and the upsert of a run's claim decision. Every call runs
// inside the claim's transaction, under the claim lock.

import type { Hold, Holder } from "../../../core/coordination.js";
import type { ClaimDecision, RunId, Timestamp, WorkItem } from "../../../core/types.js";
import type { Row, SqlExecutor, SqlValue } from "../../../state/index.js";
import { placeholders } from "./retention.js";
import { rowToClaimDecision } from "./rows.js";

/**
 * The stored decision of a queued run whose named holder closed while it was `held` (design 05-dependencies,
 * 2026-11-23): no store reader returns it, and the next claim keeps its `held_since` as the hold's start.
 */
export const RELEASED = "released";

/** What claimRun reads once for the coordination check (design §5, 2026-11-03). */
export interface CoordContext {
  items: Map<string, WorkItem>;
  holders: Holder[];
  /** Recorded conflicts per project, then per path. */
  conflicts: Map<string, Map<string, number>>;
  decisions: Map<string, ClaimDecision>;
  /** Per queued run whose `held` decision was released when its holder closed: when its hold began. */
  released: Map<string, Timestamp>;
  /** Held by a dependency: an edge not yet merged, or `blocked_on: dependency`. */
  depHeld: (id: string) => boolean;
  /** Per item: when its first implement run was queued and started. */
  times: Map<string, { queued: Timestamp | null; started: Timestamp | null }>;
  /** Per queued item: its place in the claim order. */
  order: Map<string, number>;
  /** Per queued item: whether its run is held (stored, or decided earlier in this claim). */
  held: Map<string, boolean>;
}

/** The stored decisions of queued runs `runIds`, and apart the hold start of each one `released`. */
export async function claimDecisionsOf(tx: SqlExecutor, runIds: readonly string[]): Promise<Pick<CoordContext, "decisions" | "released">> {
  const decisions: CoordContext["decisions"] = new Map();
  const released: CoordContext["released"] = new Map();
  for (const r of await tx.all(`SELECT * FROM controller_claim_decisions WHERE run_id IN (${placeholders(runIds.length)})`, [...runIds])) {
    if (r.decision === RELEASED) released.set(r.run_id as string, r.held_since as Timestamp);
    else decisions.set(r.run_id as string, rowToClaimDecision(r));
  }
  return { decisions, released };
}

/**
 * Closed item `id` holds nothing from this commit on (design §5, 2026-11-07): the queued runs' decisions that name it
 * go, except an approval. A `held` one is kept `released` with its `held_since` (oldest held first, 2026-11-23).
 */
export async function releaseHolder(tx: SqlExecutor, id: string): Promise<void> {
  const naming = `holder_work_item_id = ? AND approved_by IS NULL AND run_id IN (SELECT id FROM worker_runs WHERE status = 'queued')`;
  await tx.run(`UPDATE controller_claim_decisions SET decision = '${RELEASED}', held_since = COALESCE(held_since, at) WHERE decision = 'held' AND ${naming}`, [id]);
  await tx.run(`DELETE FROM controller_claim_decisions WHERE decision <> '${RELEASED}' AND ${naming}`, [id]);
}

/** Per item of `ids`: when its first implement run was queued and when one first started (null: none yet). */
export async function implementTimes(tx: SqlExecutor, ids: readonly string[]): Promise<CoordContext["times"]> {
  const times: CoordContext["times"] = new Map();
  if (ids.length === 0) return times;
  for (const r of await tx.all(
    `SELECT work_item_id, MIN(created_at) AS queued, MIN(started_at) AS started FROM worker_runs
     WHERE kind = 'implement' AND work_item_id IN (${placeholders(ids.length)}) GROUP BY work_item_id`,
    [...ids],
  )) {
    times.set(r.work_item_id as string, { queued: (r.queued as Timestamp | null) ?? null, started: (r.started as Timestamp | null) ?? null });
  }
  return times;
}

/**
 * Each queued item's place in the claim order (`runs` come in claim order), and whether its run is held now by its
 * stored decision (`held`, not approved): an older held run holds the newer runs it overlaps.
 */
export function claimOrder(runs: readonly Row[], decisions: ReadonlyMap<string, ClaimDecision>): Pick<CoordContext, "order" | "held"> {
  const order = new Map<string, number>();
  const held = new Map<string, boolean>();
  for (const [i, q] of runs.entries()) {
    const id = q.work_item_id as string;
    if (order.has(id)) continue;
    order.set(id, i);
    const d = decisions.get(q.id as string);
    held.set(id, d?.decision === "held" && d.approved_by === null);
  }
  return { order, held };
}

/** Upserts the run's claim decision; a decision equal to the stored one writes nothing. approved_by is kept. */
export async function writeClaimDecision(
  tx: SqlExecutor, insertOnce: (sql: string, params: SqlValue[]) => Promise<boolean>, now: Timestamp,
  d: { it: WorkItem; runId: RunId; decision: ClaimDecision["decision"]; hold: Hold; threshold: number; existing: ClaimDecision | null; held_since: Timestamp },
): Promise<void> {
  const { hold, existing } = d;
  const row = {
    decision: d.decision,
    holder_work_item_id: hold.holder.work_item_id,
    holder_ref: hold.holder.ref,
    holder_kind: hold.holder.kind,
    shared: JSON.stringify(hold.shared),
    cost: hold.cost,
    threshold: d.threshold,
    fallback: hold.holder.fallback ? 1 : 0,
    held_since: d.held_since,
  };
  if (
    existing && existing.decision === row.decision && existing.holder_work_item_id === row.holder_work_item_id &&
    existing.holder_ref === row.holder_ref && existing.holder_kind === row.holder_kind &&
    JSON.stringify(existing.shared) === row.shared && existing.cost === row.cost && existing.threshold === row.threshold &&
    (existing.fallback ? 1 : 0) === row.fallback && existing.held_since === row.held_since
  ) {
    return;
  }
  const values = [
    row.decision, row.holder_work_item_id, row.holder_ref, row.holder_kind, row.shared, row.cost, row.threshold, row.fallback, row.held_since,
  ];
  const updated = await tx.run(
    `UPDATE controller_claim_decisions SET decision = ?, holder_work_item_id = ?, holder_ref = ?, holder_kind = ?, shared = ?, cost = ?,
       threshold = ?, fallback = ?, held_since = ?, at = ? WHERE run_id = ?`,
    [...values, now, d.runId],
  );
  if (updated === 0) {
    await insertOnce(
      `INSERT INTO controller_claim_decisions (run_id, work_item_id, decision, holder_work_item_id, holder_ref, holder_kind, shared, cost,
         threshold, fallback, held_since, approved_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [d.runId, d.it.id, ...values, now],
    );
  }
}
