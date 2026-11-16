// A finished run's status in worker_runs against its latest attempt record in worker_run_attempts. The two must
// agree: the finish paths close the current record in the same transaction as the run. A claim the reaper ended
// (lease_expired) under a failed or cancelled run agrees too: that is how the run ended. One predicate for both
// readers: doctor's check (src/setup.ts, read-only) and the one-off repair migration beside this file.

import type { SqlExecutor } from "../../state/index.js";

/** A doctor line (setup.ts's Check, which this component may not import). */
type Check = { ok: boolean; msg: string; warn?: boolean; fix?: string };

/** True for the latest attempt record `a` of run `r` when the run is finished and the two statuses disagree. */
export function mismatch(a: string, r: string): string {
  return `${a}.attempt = (SELECT MAX(b.attempt) FROM worker_run_attempts b WHERE b.run_id = ${r}.id)
    AND ${r}.status IN ('succeeded', 'failed', 'cancelled') AND ${r}.status <> ${a}.status
    AND NOT (${a}.status = 'lease_expired' AND ${r}.status IN ('failed', 'cancelled'))`;
}

/** One FAIL per run whose status and latest attempt disagree, naming the run id and both statuses; read-only. */
export async function runAttemptChecks(db: SqlExecutor): Promise<Check[]> {
  const rows = await db.all(
    `SELECT r.id, r.status AS run_status, a.status AS attempt_status FROM worker_runs r
     JOIN worker_run_attempts a ON a.run_id = r.id WHERE ${mismatch("a", "r")} ORDER BY r.id`,
  );
  if (rows.length === 0) return [{ ok: true, msg: "every finished run's status agrees with its latest attempt" }];
  return rows.map((r) => ({
    ok: false,
    msg: `run ${String(r.id)}: worker_runs.status is ${String(r.run_status)} but its latest attempt is ${String(r.attempt_status)}`,
    fix: "a store bug; `npm run migrate` repairs rows written before the worker-run-attempt-status migration",
  }));
}

/**
 * doctor's run/attempt check on a store `open` gives: its SQL access (null: not a SQL store, no such tables, no
 * line) and its close. A store that cannot be read is a warn whose text names the check only, since the error
 * could carry a connection string.
 */
export async function storeRunAttemptChecks(open: () => Promise<{ sql: SqlExecutor | null; close(): Promise<void> }>): Promise<Check[]> {
  let store: Awaited<ReturnType<typeof open>> | null = null;
  try {
    store = await open();
    return store.sql === null ? [] : await runAttemptChecks(store.sql);
  } catch {
    return [{ ok: false, warn: true, msg: "run and attempt status: could not read the store" }];
  } finally {
    await store?.close().catch(() => undefined);
  }
}
