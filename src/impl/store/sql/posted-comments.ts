// The reads of the sync sources' posted-comment records (`outbound_deliveries`) that reactions need (issue #524):
// kept out of sql-factory-store.ts so that file stays within its line budget. Read-only; no schema change.

import type { Timestamp } from "../../../core/types.js";
import type { PostedComment } from "../../../interfaces/factory-store.js";
import type { Row, SqlExecutor } from "../../../state/index.js";

/** The posted records whose comment ID is `comment_id`, oldest first; rows of failed posts only have none. */
export async function listPostedCommentsById(db: SqlExecutor, comment_id: string): Promise<PostedComment[]> {
  const rows = await db.all("SELECT * FROM outbound_deliveries WHERE comment_id = ? ORDER BY created_at, updated_at, marker", [comment_id]);
  return rows.map(rowToPostedComment);
}

/**
 * The comments posted on sources whose id starts with `source_prefix` at or after `since`, oldest first. A posted
 * row's updated_at is its post time: recordPostedComment never updates a row that already has a comment.
 */
export async function listPostedComments(db: SqlExecutor, source_prefix: string, since: Timestamp): Promise<PostedComment[]> {
  const rows = await db.all(
    `SELECT * FROM outbound_deliveries WHERE comment_id IS NOT NULL AND updated_at >= ? AND SUBSTR(source_id, 1, ?) = ?
     ORDER BY updated_at, source_id, marker`,
    [since, source_prefix.length, source_prefix],
  );
  return rows.map(rowToPostedComment);
}

export function rowToPostedComment(row: Row): PostedComment {
  return {
    source_id: row.source_id as string,
    marker: row.marker as string,
    comment_id: (row.comment_id as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    body_hash: (row.body_hash as string | null) ?? null,
    attempts: Number(row.attempts),
    next_attempt_at: (row.next_attempt_at as Timestamp | null) ?? null,
  };
}
