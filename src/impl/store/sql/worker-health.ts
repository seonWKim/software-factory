// Worker processes (design §5 Coordination, 2026-11-07), host sleeps (design §5 Host sleep, issue #218) and restart
// history (design 05-restarts), kept out of sql-factory-store.ts so that file stays
// within its line budget. Every write is keyed, so a repeat or another replica stores one row.

import { createHash } from "node:crypto";
import type { HostSleep, Timestamp, WorkerId, WorkItemId } from "../../../core/types.js";
import type { WorkerProcess, WorkerProcessReport } from "../../../interfaces/factory-store.js";
import type { ChildRestart } from "../../../interfaces/updater.js";
import type { Row, SqlDriver, SqlValue } from "../../../state/index.js";
import { activityOf, insertActivity, logRef } from "./activity.js";
import { rowToHostSleep } from "./rows.js";
import { type StoreTime, insertOnce } from "./store-steps.js";

export async function reportWorkerProcess(db: SqlDriver, time: StoreTime, r: WorkerProcessReport): Promise<WorkerProcess> {
  const reported_at = time.now();
  const values: SqlValue[] = [r.pid, r.host, r.slots, r.max_slots, r.busy, r.index_base, r.started_at, reported_at];
  const update = () =>
    db.run(
      `UPDATE worker_processes SET pid = ?, host = ?, slots = ?, max_slots = ?, busy = ?, index_base = ?, started_at = ?, reported_at = ?
       WHERE process_id = ?`,
      [...values, r.process_id],
    );
  // Keyed by process_id: update the row, else insert it; a concurrent first insert that loses updates instead.
  if ((await update()) === 0) {
    const sql = `INSERT INTO worker_processes (pid, host, slots, max_slots, busy, index_base, started_at, reported_at, process_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    if (!(await insertOnce(db, db, sql, [...values, r.process_id]))) await update();
  }
  return { ...r, reported_at };
}

export async function listWorkerProcesses(db: SqlDriver, time: StoreTime, max_age_ms: number): Promise<WorkerProcess[]> {
  const since = time.after(-max_age_ms);
  const rows = await db.all("SELECT * FROM worker_processes WHERE reported_at >= ? ORDER BY host, pid, process_id", [since]);
  return rows.map(rowToWorkerProcess);
}

export async function removeWorkerProcess(db: SqlDriver, process_id: string): Promise<boolean> {
  return (await db.run("DELETE FROM worker_processes WHERE process_id = ?", [process_id])) > 0;
}

// Host sleeps (design §5 Host sleep, issue #218): one row per (worker_id, woke_at).

export async function recordHostSleep(db: SqlDriver, sleep: HostSleep): Promise<{ created: boolean; sleep: HostSleep }> {
  const existing = await selectHostSleep(db, sleep.worker_id, sleep.woke_at);
  if (existing) return { created: false, sleep: existing };
  const created = await insertOnce(
    db, db,
    "INSERT INTO worker_host_sleeps (worker_id, woke_at, gap_ms, run_id) VALUES (?, ?, ?, ?)",
    [sleep.worker_id, sleep.woke_at, Math.round(sleep.gap_ms), sleep.run_id],
  );
  // A concurrent first write that lost the insert reports the row the other one stored.
  return { created, sleep: (await selectHostSleep(db, sleep.worker_id, sleep.woke_at))! };
}

export async function listHostSleeps(db: SqlDriver, opts: { limit: number; work_item_id?: WorkItemId }): Promise<HostSleep[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  // limit is an integer computed here, inlined as the other paged reads do.
  const rows = opts.work_item_id === undefined
    ? await db.all(`SELECT * FROM worker_host_sleeps ORDER BY woke_at DESC, worker_id DESC LIMIT ${limit}`)
    : await db.all(
        `SELECT h.* FROM worker_host_sleeps h JOIN worker_runs r ON r.id = h.run_id WHERE r.work_item_id = ?
         ORDER BY h.woke_at DESC, h.worker_id DESC LIMIT ${limit}`,
        [opts.work_item_id],
      );
  return rows.map(rowToHostSleep);
}

async function selectHostSleep(db: SqlDriver, worker_id: WorkerId, woke_at: Timestamp): Promise<HostSleep | null> {
  const [row] = await db.all("SELECT * FROM worker_host_sleeps WHERE worker_id = ? AND woke_at = ?", [worker_id, woke_at]);
  return row ? rowToHostSleep(row) : null;
}

// Restart history (design 05-restarts): the key is the restart's time and a hash of its reason, so the same
// restart read again from the supervisor's file, on this replica or another, is one row. A new row writes the
// supervisor's `restart` Activity row (design 08-schedules-actions) in the same transaction, at the restart's time.

export async function recordChildRestart(db: SqlDriver, restart: ChildRestart): Promise<{ created: boolean }> {
  const key = `${restart.at}:${createHash("sha256").update(restart.reason).digest("hex").slice(0, 16)}`;
  return db.transaction(async (tx) => {
    const created = await insertOnce(db, tx, "INSERT INTO runtime_child_restarts (restart_key, at, reason) VALUES (?, ?, ?)", [key, restart.at, restart.reason]);
    if (created) {
      await insertActivity(tx, restart.at as Timestamp, activityOf("restart", {
        subject: "dev child", outcome: "restarted", reason: `the supervised child exited unexpectedly: ${restart.reason}`, ref: logRef("supervisor", "child exited unexpectedly; restarting on the next poll"),
      }));
    }
    return { created };
  });
}

export async function listChildRestartsWithin(db: SqlDriver, time: StoreTime, window_ms: number): Promise<ChildRestart[]> {
  const rows = await db.all("SELECT at, reason FROM runtime_child_restarts WHERE at >= ? ORDER BY at, restart_key", [time.after(-window_ms)]);
  return rows.map((r) => ({ at: r.at as string, reason: r.reason as string }));
}

function rowToWorkerProcess(row: Row): WorkerProcess {
  return {
    process_id: row.process_id as string,
    pid: Number(row.pid),
    host: row.host as string,
    slots: Number(row.slots),
    max_slots: Number(row.max_slots),
    busy: Number(row.busy),
    index_base: Number(row.index_base),
    started_at: row.started_at as Timestamp,
    reported_at: row.reported_at as Timestamp,
  };
}
