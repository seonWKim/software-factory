// Coordination (design §5, 2026-11-03; design 05-dependencies): dependency edges and claim holds, kept out of
// sql-factory-store.ts so that file stays within its line budget. The claim and the recorded file conflicts its cost
// rule reads stay in the class; a hold's approval runs the class's transition (store-steps.ts) in the same transaction.

import type { ClaimDecision, DependencyEdge, DependencyState, Timestamp, WorkItemId } from "../../../core/types.js";
import type { DependencyLink } from "../../../core/coordination.js";
import type { ApproveClaimHoldInput, ApproveClaimHoldResult } from "../../../interfaces/factory-store.js";
import type { SqlDriver, SqlValue } from "../../../state/index.js";
import { RELEASED } from "./claim-coordination.js";
import { placeholders } from "./retention.js";
import { rowToClaimDecision, rowToDependencyEdge } from "./rows.js";
import { type StoreSteps, type StoreTime, insertOnce } from "./store-steps.js";

export async function replaceDependencyEdges(db: SqlDriver, time: StoreTime, id: WorkItemId, links: readonly DependencyLink[], read_at?: Timestamp): Promise<DependencyEdge[]> {
  return db.transaction(async (tx) => {
    const now = time.now();
    const wanted = new Map<string, DependencyLink>();
    for (const l of links) if (!wanted.has(l.depends_on)) wanted.set(l.depends_on, l);
    const current = (await tx.all("SELECT depends_on FROM controller_dependency_edges WHERE work_item_id = ?", [id])).map((r) => r.depends_on as string);
    for (const d of current) {
      if (!wanted.has(d)) await tx.run("DELETE FROM controller_dependency_edges WHERE work_item_id = ? AND depends_on = ?", [id, d]);
    }
    for (const l of wanted.values()) {
      await insertOnce(
        db, tx,
        "INSERT INTO controller_dependency_edges (work_item_id, depends_on, kind, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)",
        [id, l.depends_on, l.kind, now, now],
      );
    }
    if (read_at !== undefined) {
      await tx.run("UPDATE controller_dependency_edges SET source_updated_at = ? WHERE work_item_id = ?", [read_at, id]);
      await tx.run("UPDATE controller_work_items SET edges_source_updated_at = ? WHERE id = ?", [read_at, id]);
    }
    const rows = await tx.all(`SELECT * FROM controller_dependency_edges WHERE work_item_id = ? ORDER BY created_at, ${db.dialect.seq}`, [id]);
    return rows.map(rowToDependencyEdge);
  });
}

export async function dependencyLinksReadAt(db: SqlDriver, id: WorkItemId): Promise<Timestamp | null> {
  const [row] = await db.all("SELECT edges_source_updated_at FROM controller_work_items WHERE id = ?", [id]);
  return (row?.edges_source_updated_at as Timestamp | null | undefined) ?? null;
}

export async function markDependencyLinksStale(db: SqlDriver, id: WorkItemId): Promise<void> {
  await db.run("UPDATE controller_work_items SET edges_source_updated_at = NULL WHERE id = ?", [id]);
}

export async function listDependencyEdges(db: SqlDriver, filter: { work_item_id?: WorkItemId; depends_on?: string } = {}): Promise<DependencyEdge[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filter.work_item_id !== undefined) {
    where.push("work_item_id = ?");
    params.push(filter.work_item_id);
  }
  if (filter.depends_on !== undefined) {
    where.push("depends_on = ?");
    params.push(filter.depends_on);
  }
  const rows = await db.all(
    `SELECT * FROM controller_dependency_edges${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, ${db.dialect.seq}`,
    params,
  );
  return rows.map(rowToDependencyEdge);
}

export async function setDependencyState(db: SqlDriver, time: StoreTime, id: WorkItemId, depends_on: string, state: DependencyState): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.all("SELECT state FROM controller_dependency_edges WHERE work_item_id = ? AND depends_on = ?", [id, depends_on]);
    if (!row) return false;
    if (row.state !== state) {
      await tx.run("UPDATE controller_dependency_edges SET state = ?, updated_at = ? WHERE work_item_id = ? AND depends_on = ?", [
        state, time.now(), id, depends_on,
      ]);
    }
    return true;
  });
}

export function listClaimDecisions(db: SqlDriver, id: WorkItemId): Promise<ClaimDecision[]> { return claimDecisionsWhere(db, "work_item_id = ?", [id]); }
export function listClaimDecisionsSince(db: SqlDriver, since: Timestamp): Promise<ClaimDecision[]> { return claimDecisionsWhere(db, "at >= ?", [since]); }
async function claimDecisionsWhere(db: SqlDriver, where: string, args: readonly string[]): Promise<ClaimDecision[]> {
  return (await db.all(
    `SELECT * FROM controller_claim_decisions WHERE decision <> '${RELEASED}' AND (${where}) ORDER BY at, ${db.dialect.seq}`, [...args],
  )).map(rowToClaimDecision);
}

export async function listLatestClaimDecisions(db: SqlDriver, ids: readonly WorkItemId[]): Promise<Map<WorkItemId, ClaimDecision>> {
  const out = new Map<WorkItemId, ClaimDecision>();
  if (ids.length === 0) return out;
  for (const d of await claimDecisionsWhere(db, `work_item_id IN (${placeholders(ids.length)})`, ids)) out.set(d.work_item_id, d); // oldest first: the last one wins
  return out;
}

export async function approveClaimHold(db: SqlDriver, store: StoreSteps, input: ApproveClaimHoldInput): Promise<ApproveClaimHoldResult> {
  return db.transaction(async (tx): Promise<ApproveClaimHoldResult> => {
    const [row] = await tx.all(
      `SELECT d.* FROM controller_claim_decisions d JOIN worker_runs r ON r.id = d.run_id
       WHERE d.run_id = ? AND d.work_item_id = ? AND d.decision = 'held' AND d.approved_by IS NULL AND r.status = 'queued'`,
      [input.run_id, input.id],
    );
    if (!row) return { ok: false, reason: "not_held" };
    const held = rowToClaimDecision(row);
    const r = await store.applyTransition(tx, {
      id: input.id,
      expected_version: input.expected_version,
      patch: {},
      actor: input.actor,
      reason: "coordination_approved",
      detail: { run_id: input.run_id, holder: held.holder_ref, cost: held.cost, threshold: held.threshold },
    });
    if (!r.ok) return r;
    await tx.run("UPDATE controller_claim_decisions SET approved_by = ? WHERE run_id = ?", [input.actor.id, input.run_id]);
    const [after] = await tx.all("SELECT * FROM controller_claim_decisions WHERE run_id = ?", [input.run_id]);
    return { ok: true, item: r.item, state_change: r.state_change, decision: rowToClaimDecision(after!) };
  });
}
