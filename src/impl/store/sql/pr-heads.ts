// PR heads and handoffs: the writes fenced by a run's lease token or by the item's last head, kept out of
// sql-factory-store.ts so that file stays within its line budget.

import { prNumber } from "../../../core/change-ref.js";
import type { Handoff, Run, RunId, RunOutcome, WorkItemId } from "../../../core/types.js";
import type { RecordPrHeadInput, RecordPrHeadResult } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import { newId, rowToHandoff } from "./rows.js";
import { type StoreSteps, type StoreTime, insertOnce } from "./store-steps.js";

export async function recordPushedHead(db: SqlDriver, runId: RunId, token: number, head_sha: string): Promise<{ ok: true } | { ok: false; reason: "lease_lost" }> {
  return db.transaction(async (tx) => {
    // As appendHandoff: the run stays `running` with this token until this commits.
    const [held] = await tx.all(
      `SELECT work_item_id FROM worker_runs WHERE id = ? AND status = 'running' AND lease_token = ?`,
      [runId, token],
    );
    if (!held) return { ok: false, reason: "lease_lost" };
    await tx.run("UPDATE controller_work_items SET last_head_sha = ? WHERE id = ?", [head_sha, held.work_item_id as string]);
    return { ok: true };
  });
}

export async function recordPrHead(db: SqlDriver, time: StoreTime, store: StoreSteps, input: RecordPrHeadInput): Promise<RecordPrHeadResult> {
  return db.transaction(async (tx): Promise<RecordPrHeadResult> => {
    const current = await store.selectItem(tx, input.id);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.last_head_sha !== input.expected_head) return { ok: false, reason: "head_moved", current };
    const moved = await tx.run(
      `UPDATE controller_work_items SET last_head_sha = ? WHERE id = ? AND ${input.expected_head === null ? "last_head_sha IS NULL" : "last_head_sha = ?"}`,
      input.expected_head === null ? [input.head_sha, input.id] : [input.head_sha, input.id, input.expected_head],
    );
    if (moved !== 1) return { ok: false, reason: "head_moved", current };
    let run: Run | null = null;
    if (input.manual && input.expected_head !== null) {
      const now = time.now();
      const outcome: RunOutcome = {
        status: "succeeded",
        summary: "a person pushed to the PR branch",
        data: { actor: input.manual.actor, from_sha: input.expected_head, to_sha: input.head_sha, pr_number: prNumber({ change_ref: input.manual.change_ref }) },
      };
      const id = newId("run") as RunId;
      // Written finished and acknowledged: never queued, so no claim returns it and the controller applies nothing.
      const inserted = await insertOnce(
        db, tx,
        `INSERT INTO worker_runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, outcome, acknowledged_at,
           started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, 'manual', ?, 'succeeded', 0, 0, ?, ?, ?, ?, ?, ?)`,
        [id, input.id, `${input.id}:manual:${input.expected_head}..${input.head_sha}`, JSON.stringify(outcome), now, now, now, now, now],
      );
      run = inserted ? await store.selectRun(tx, id) : null;
    }
    return { ok: true, item: (await store.selectItem(tx, input.id))!, run };
  });
}

export async function appendHandoff(
  db: SqlDriver, time: StoreTime, input: Omit<Handoff, "id" | "at">, token: number,
): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }> {
  return db.transaction(async (tx) => {
    const now = time.now();
    // Status and token are what fence the holder; the write transaction keeps the reaper and a
    // completion from moving the run out of 'running' (and a reclaim from bumping the token) until this commits.
    const [holds] = await tx.all(
      `SELECT 1 AS held FROM worker_runs WHERE id = ? AND work_item_id = ? AND status = 'running' AND lease_token = ?`,
      [input.run_id, input.work_item_id, token],
    );
    if (!holds) return { ok: false, reason: "lease_lost" };
    await insertOnce(
      db, tx,
      `INSERT INTO controller_handoffs (id, run_id, work_item_id, commit_sha, worked_on, next_steps, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId("ho"), input.run_id, input.work_item_id, input.commit_sha, input.worked_on, input.next_steps, now],
    );
    const [row] = await tx.all("SELECT * FROM controller_handoffs WHERE run_id = ? AND commit_sha = ?", [input.run_id, input.commit_sha]);
    return { ok: true, handoff: rowToHandoff(row!) };
  });
}

export async function listHandoffs(db: SqlDriver, id: WorkItemId): Promise<Handoff[]> {
  const rows = await db.all(`SELECT * FROM controller_handoffs WHERE work_item_id = ? ORDER BY at, ${db.dialect.seq}`, [id]);
  return rows.map(rowToHandoff);
}
