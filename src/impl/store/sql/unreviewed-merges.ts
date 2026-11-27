// Unreviewed merges (design 2026-11-01): PRs merged with no work item, one row per (project, change_ref), and the
// title backfill of rows recorded before titles were kept (design 09-dashboard-tasks-needs). Kept out of
// sql-factory-store.ts so that file stays within its line budget.

import type { Timestamp, UnreviewedMerge, UnreviewedMergeId } from "../../../core/types.js";
import type { NewUnreviewedMerge } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import { newId, rowToUnreviewedMerge } from "./rows.js";
import { insertOnce } from "./store-steps.js";

export async function recordUnreviewedMerge(db: SqlDriver, now: Timestamp, input: NewUnreviewedMerge): Promise<{ merge: UnreviewedMerge; created: boolean }> {
  return db.transaction(async (tx) => {
    const created = await insertOnce(
      db,
      tx,
      "INSERT INTO controller_unreviewed_merges (id, project, change_ref, merge_sha, merger_id, at, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [newId("um") as UnreviewedMergeId, input.project, input.change_ref, input.merge_sha, input.merger_id, now, input.title ?? null],
    );
    const [row] = await tx.all("SELECT * FROM controller_unreviewed_merges WHERE project = ? AND change_ref = ?", [input.project, input.change_ref]);
    return { merge: rowToUnreviewedMerge(row!), created };
  });
}

export async function listUnreviewedMerges(db: SqlDriver, limit: number): Promise<UnreviewedMerge[]> {
  const rows = await db.all(`SELECT * FROM controller_unreviewed_merges ORDER BY at DESC, ${db.dialect.seq} DESC LIMIT ?`, [limit]);
  return rows.map(rowToUnreviewedMerge);
}

export async function countUnreviewedMergesSince(db: SqlDriver, since: Timestamp): Promise<number> {
  const [row] = await db.all("SELECT COUNT(*) AS n FROM controller_unreviewed_merges WHERE at >= ?", [since]);
  return Number(row!.n);
}

export async function listUntitledUnreviewedMerges(db: SqlDriver, project: string, limit: number): Promise<UnreviewedMerge[]> {
  const rows = await db.all(
    `SELECT * FROM controller_unreviewed_merges WHERE project = ? AND title IS NULL ORDER BY at DESC, ${db.dialect.seq} DESC LIMIT ?`,
    [project, limit],
  );
  return rows.map(rowToUnreviewedMerge);
}

/** A conditional update: a row that already has a title keeps it, so two workers filling the same row agree. */
export async function setUnreviewedMergeTitle(db: SqlDriver, id: UnreviewedMergeId, title: string): Promise<void> {
  await db.run("UPDATE controller_unreviewed_merges SET title = ? WHERE id = ? AND title IS NULL", [title, id]);
}
