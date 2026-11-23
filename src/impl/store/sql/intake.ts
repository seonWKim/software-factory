// Cursors and stream intake: the inbound cursors and the raw-record inbox, kept out of sql-factory-store.ts so that
// file stays within its line budget. An append is fenced by its listener lease's token (the leases stay in the class).

import type { SourceType, Timestamp } from "../../../core/types.js";
import type { AppendInboxResult, InboxRow, NewInboxEvent } from "../../../interfaces/factory-store.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { type StoreTime, insertOnce } from "./store-steps.js";

export async function getCursor(db: SqlDriver, name: string): Promise<string | null> {
  const [row] = await db.all("SELECT value FROM inbound_cursors WHERE name = ?", [name]);
  return (row?.value as string | undefined) ?? null;
}

export async function advanceCursor(db: SqlDriver, name: string, expected: string | null, next: string): Promise<boolean> {
  return db.transaction(async (tx) =>
    expected === null
      ? insertOnce(db, tx, "INSERT INTO inbound_cursors (name, value) VALUES (?, ?)", [name, next])
      : (await tx.run("UPDATE inbound_cursors SET value = ? WHERE name = ? AND value = ?", [next, name, expected])) === 1,
  );
}

// Stream intake

export async function appendInbox(db: SqlDriver, time: StoreTime, input: NewInboxEvent): Promise<AppendInboxResult> {
  return db.transaction(async (tx): Promise<AppendInboxResult> => {
    // On the lease row: a takeover (token + 1) waits for this append to commit, and appends of
    // one source type commit one at a time, so their seqs commit in order and a cursor never skips one.
    const [held] = await tx.all(
      `SELECT token FROM inbound_listener_leases WHERE source_type = ? AND token = ?`,
      [input.source_type, input.lease_token],
    );
    if (!held) return { ok: false, reason: "lease_lost" };
    const existing = await selectInbox(tx, input.source_type, input.dedupe_key);
    if (existing) return { ok: true, row: existing, duplicate: true };
    const inserted = await insertOnce(
      db, tx,
      "INSERT INTO inbound_raw_records (source_type, dedupe_key, event, received_at) VALUES (?, ?, ?, ?)",
      [input.source_type, input.dedupe_key, JSON.stringify(input.event), time.now()],
    );
    const row = (await selectInbox(tx, input.source_type, input.dedupe_key))!;
    return { ok: true, row, duplicate: !inserted };
  });
}

export async function listInboxAfter(db: SqlDriver, source_type: SourceType, after_seq: number, limit: number): Promise<InboxRow[]> {
  const rows = await db.all("SELECT * FROM inbound_raw_records WHERE source_type = ? AND seq > ? ORDER BY seq LIMIT ?", [
    source_type, after_seq, limit,
  ]);
  return rows.map(rowToInbox);
}

async function selectInbox(q: SqlExecutor, source_type: SourceType, dedupe_key: string): Promise<InboxRow | null> {
  const [row] = await q.all("SELECT * FROM inbound_raw_records WHERE source_type = ? AND dedupe_key = ?", [source_type, dedupe_key]);
  return row ? rowToInbox(row) : null;
}

function rowToInbox(row: Row): InboxRow {
  return {
    seq: Number(row.seq),
    source_type: row.source_type as SourceType,
    dedupe_key: row.dedupe_key as string,
    event: JSON.parse(row.event as string) as SourceEvent,
    received_at: row.received_at as Timestamp,
  };
}
