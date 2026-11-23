// Merge checks (design §5 Merge check, issue #248) and GitHub sync records (design §5, GitHub call budget): posted
// comments and label states, shared by replicas. Kept out of sql-factory-store.ts so that file stays within its line
// budget; the reads for reactions are in posted-comments.ts.

import { createHash } from "node:crypto";
import type { Timestamp, WorkItemId } from "../../../core/types.js";
import type { LabelState, LabelTarget, MergeCheck, NewMergeCheck, NewPostedComment, PostedComment } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver, SqlValue } from "../../../state/index.js";
import * as posted from "./posted-comments.js";
import { placeholders } from "./retention.js";
import { newId } from "./rows.js";
import { type StoreTime, insertOnce } from "./store-steps.js";

export async function recordMergeCheck(db: SqlDriver, time: StoreTime, c: NewMergeCheck): Promise<MergeCheck> {
  const checked_at = time.now();
  const values: SqlValue[] = [c.mergeable ? 1 : 0, JSON.stringify(c.conflicts), c.head_sha, c.base_sha, checked_at];
  const update = () => db.run("UPDATE controller_merge_checks SET mergeable = ?, conflicts = ?, head_sha = ?, base_sha = ?, checked_at = ? WHERE work_item_id = ?", [...values, c.work_item_id]);
  // Keyed by work_item_id: update the row, else insert it; a concurrent first insert that loses updates instead.
  if ((await update()) === 0) {
    const sql = "INSERT INTO controller_merge_checks (mergeable, conflicts, head_sha, base_sha, checked_at, work_item_id) VALUES (?, ?, ?, ?, ?, ?)";
    if (!(await insertOnce(db, db, sql, [...values, c.work_item_id]))) await update();
  }
  return { ...c, conflicts: [...c.conflicts], checked_at };
}

export async function getMergeCheck(db: SqlDriver, work_item_id: WorkItemId): Promise<MergeCheck | null> {
  const [row] = await db.all("SELECT * FROM controller_merge_checks WHERE work_item_id = ?", [work_item_id]);
  return row ? rowToMergeCheck(row) : null;
}

export async function clearMergeCheck(db: SqlDriver, work_item_id: WorkItemId): Promise<boolean> {
  return (await db.run("DELETE FROM controller_merge_checks WHERE work_item_id = ?", [work_item_id])) > 0;
}
export async function listMergeChecks(db: SqlDriver, work_item_ids: readonly WorkItemId[]): Promise<MergeCheck[]> {
  if (work_item_ids.length === 0) return [];
  const rows = await db.all(`SELECT * FROM controller_merge_checks WHERE work_item_id IN (${placeholders(work_item_ids.length)})`, [...work_item_ids]);
  return rows.map(rowToMergeCheck);
}

export async function getPostedComment(
  db: SqlDriver, time: StoreTime, source_id: string, marker: string, body: string,
): Promise<(PostedComment & { same_body: boolean; waiting: boolean }) | null> {
  const [row] = await db.all("SELECT * FROM outbound_deliveries WHERE source_id = ? AND marker = ?", [source_id, marker]);
  if (!row) return null;
  const c = posted.rowToPostedComment(row);
  return { ...c, same_body: c.body_hash === bodyHash(body), waiting: c.next_attempt_at !== null && c.next_attempt_at > time.now() };
}

export async function recordPostedComment(db: SqlDriver, time: StoreTime, c: NewPostedComment): Promise<void> {
  const now = time.now();
  const values: SqlValue[] = [c.comment_id, c.url, bodyHash(c.body), now];
  // A row of failed posts only gets the comment; a row that has one keeps it.
  const update = () =>
    db.run(
      `UPDATE outbound_deliveries SET comment_id = ?, url = ?, body_hash = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
       WHERE source_id = ? AND marker = ? AND comment_id IS NULL`,
      [...values, c.source_id, c.marker],
    );
  if ((await update()) > 0) return;
  const sql = `INSERT INTO outbound_deliveries (comment_id, url, body_hash, attempts, next_attempt_at, created_at, updated_at, source_id, marker)
       VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)`;
  if (!(await insertOnce(db, db, sql, [...values, now, c.source_id, c.marker]))) await update();
}

export async function recordCommentFailure(db: SqlDriver, time: StoreTime, source_id: string, marker: string, attempts: number, delay_ms: number): Promise<boolean> {
  const now = time.now();
  const next_attempt_at = time.after(delay_ms);
  if (attempts === 1) {
    const inserted = await insertOnce(
      db, db,
      `INSERT INTO outbound_deliveries (source_id, marker, comment_id, url, body_hash, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`,
      [source_id, marker, next_attempt_at, now, now],
    );
    if (inserted) return true;
  }
  const changed = await db.run(
    "UPDATE outbound_deliveries SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE source_id = ? AND marker = ? AND attempts = ?",
    [attempts, next_attempt_at, now, source_id, marker, attempts - 1],
  );
  return changed > 0;
}

export async function claimLabelWrite(db: SqlDriver, time: StoreTime, source_id: string, target: LabelTarget, status: string, ttl_ms: number): Promise<string | null> {
  const token = newId("lbl");
  const now = time.now();
  const until = time.after(ttl_ms);
  return db.transaction(async (tx) => {
    const [row] = await tx.all(
      `SELECT * FROM outbound_label_states WHERE source_id = ? AND target = ?`, [source_id, target],
    );
    if (!row) {
      const inserted = await insertOnce(
        db, tx,
        `INSERT INTO outbound_label_states (source_id, target, status, claim_token, claim_status, claim_until, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        [source_id, target, token, status, until, now],
      );
      // A concurrent first claim committed first: that write is under way.
      return inserted ? token : null;
    }
    if (row.status === status) return null;
    const held = row.claim_token !== null && row.claim_status === status && String(row.claim_until) > now;
    if (held) return null;
    // Conditional on the claim read, so of two replicas taking over the same row only one wins.
    const changed = await tx.run(
      `UPDATE outbound_label_states SET claim_token = ?, claim_status = ?, claim_until = ?, updated_at = ?
       WHERE source_id = ? AND target = ? AND ${row.claim_token === null ? "claim_token IS NULL" : "claim_token = ?"}`,
      [token, status, until, now, source_id, target, ...(row.claim_token === null ? [] : [row.claim_token as string])],
    );
    return changed > 0 ? token : null;
  });
}

export async function recordLabelState(db: SqlDriver, time: StoreTime, source_id: string, target: LabelTarget, status: string, token: string): Promise<void> {
  await db.run(
    `UPDATE outbound_label_states SET status = ?, claim_token = NULL, claim_status = NULL, claim_until = NULL, updated_at = ?
     WHERE source_id = ? AND target = ? AND claim_token = ?`,
    [status, time.now(), source_id, target, token],
  );
}

export async function releaseLabelClaim(db: SqlDriver, source_id: string, target: LabelTarget, token: string): Promise<void> {
  await db.run(
    "UPDATE outbound_label_states SET claim_token = NULL, claim_status = NULL, claim_until = NULL WHERE source_id = ? AND target = ? AND claim_token = ?",
    [source_id, target, token],
  );
}

export async function listLabelStates(db: SqlDriver, source_ids: readonly string[]): Promise<LabelState[]> {
  const out: LabelState[] = [];
  // In chunks, so a long list stays under every backend's parameter limit.
  for (let i = 0; i < source_ids.length; i += 500) {
    const chunk = source_ids.slice(i, i + 500);
    const rows = await db.all(`SELECT * FROM outbound_label_states WHERE source_id IN (${placeholders(chunk.length)})`, [...chunk]);
    out.push(...rows.map(rowToLabelState));
  }
  return out;
}

/** A posted comment's body is stored only as this hash: enough to tell that a repeat post changed it. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function rowToLabelState(row: Row): LabelState {
  return { source_id: row.source_id as string, target: row.target as LabelTarget, status: (row.status as string | null) ?? null, updated_at: row.updated_at as Timestamp };
}

function rowToMergeCheck(row: Row): MergeCheck {
  return {
    work_item_id: row.work_item_id as WorkItemId, mergeable: Number(row.mergeable) === 1, conflicts: JSON.parse(row.conflicts as string) as string[],
    head_sha: row.head_sha as string, base_sha: row.base_sha as string, checked_at: row.checked_at as Timestamp,
  };
}
