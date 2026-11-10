// The signal ledger's store reads and its one write (design 11-signal-ledger), kept out of sql-factory-store.ts so
// that file stays within its line budget. Each read is across items, oldest first, from `since` (null: every row).

import type { Run, RunKind, RunStatus, StateChange, Timestamp, Verdict, WorkItemId } from "../../../core/types.js";
import type { NewSignal } from "../../../interfaces/factory-store.js";
import type { SqlDriver, SqlValue } from "../../../state/index.js";
import { newId, rowToRun, rowToStateChange, rowToVerdict } from "./rows.js";

/** Work item IDs per `IN (...)` list: well under every backend's bound-parameter limit. */
const ID_CHUNK = 500;

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** `AND <column> >= ?` with its parameter when `since` is set; nothing when it is null. */
function from(column: string, since: Timestamp | null): { sql: string; params: SqlValue[] } {
  return since === null ? { sql: "", params: [] } : { sql: ` AND ${column} >= ?`, params: [since] };
}

/** Inserts the signal, or skips it when its (source, source_ref) is stored; true when it inserted. */
export async function recordSignal(db: SqlDriver, s: NewSignal): Promise<boolean> {
  try {
    await db.run(
      "INSERT INTO controller_signals (id, source, source_ref, kind, work_item_id, role, rule, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [newId("sg"), s.source, s.source_ref, s.kind, s.work_item_id, s.role, s.rule, s.at],
    );
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}

export async function latestSignalTimes(db: SqlDriver): Promise<Map<string, Timestamp>> {
  const rows = await db.all("SELECT source, MAX(at) AS at FROM controller_signals GROUP BY source");
  return new Map(rows.map((r) => [String(r.source), r.at as Timestamp]));
}

/** One read for every window, each a range on the (source, at) index. */
export async function listSignalRefs(
  db: SqlDriver, windows: readonly { source: string; since: Timestamp }[],
): Promise<{ source: string; source_ref: string }[]> {
  if (windows.length === 0) return [];
  const where = windows.map(() => "(source = ? AND at >= ?)").join(" OR ");
  const rows = await db.all(`SELECT source, source_ref FROM controller_signals WHERE ${where}`, windows.flatMap((w) => [w.source, w.since]));
  return rows.map((r) => ({ source: String(r.source), source_ref: String(r.source_ref) }));
}

export async function listStateChangesSince(
  db: SqlDriver, q: { reasons: readonly string[]; since: Timestamp | null; work_item_ids?: readonly WorkItemId[] },
): Promise<StateChange[]> {
  if (q.reasons.length === 0) return [];
  const since = from("at", q.since);
  const base = `SELECT * FROM controller_state_changes WHERE reason IN (${marks(q.reasons.length)})${since.sql}`;
  const read = async (ids: readonly WorkItemId[] | null) => {
    const sql = ids === null ? base : `${base} AND work_item_id IN (${marks(ids.length)})`;
    return db.all(`${sql} ORDER BY at, id`, [...q.reasons, ...since.params, ...(ids ?? [])]);
  };
  if (q.work_item_ids === undefined) return (await read(null)).map(rowToStateChange);
  const out: StateChange[] = [];
  for (let i = 0; i < q.work_item_ids.length; i += ID_CHUNK) out.push(...(await read(q.work_item_ids.slice(i, i + ID_CHUNK))).map(rowToStateChange));
  return out;
}

export async function listVerdictsSince(db: SqlDriver, since: Timestamp | null): Promise<Verdict[]> {
  const f = from("at", since);
  const rows = await db.all(`SELECT * FROM controller_verdicts WHERE 1 = 1${f.sql} ORDER BY at, ${db.dialect.seq}`, f.params);
  return rows.map(rowToVerdict);
}

export async function listRunsFinishedSince(
  db: SqlDriver, q: { status: RunStatus; kinds?: readonly RunKind[]; since: Timestamp | null },
): Promise<Run[]> {
  const at = "COALESCE(finished_at, updated_at)";
  const kinds = q.kinds ?? [];
  const f = from(at, q.since);
  const byKind = kinds.length > 0 ? ` AND kind IN (${marks(kinds.length)})` : "";
  const rows = await db.all(
    `SELECT * FROM worker_runs WHERE status = ?${byKind}${f.sql} ORDER BY ${at}, ${db.dialect.seq}`,
    [q.status, ...kinds, ...f.params],
  );
  return rows.map(rowToRun);
}
