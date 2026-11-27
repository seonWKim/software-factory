// The Activity record (design 08-schedules-actions): `controller_activity`, one row per autonomous action. Every
// write here takes the caller's executor, so a store method writes the row in the transaction of its change: the
// reaper's lease expiry (expireLeases), a retention batch (prunedWithActivity), a schedule claim (schedules.ts), an
// auto-grant (a transition's `activity`). A migration's row follows the migrations an open or `npm run migrate`
// applied (migrateWithActivity); past actions get none. A cleanup pass, a change outside the store, writes its row
// with recordActivity; a supervised restart's row is written by recordChildRestart (worker-health.ts).

import type { ActivityKind, ActorOf } from "../../../controller/background-jobs.js";
import type { AbandonedAttempt, Activity, ActivityStore, NewActivity } from "../../../interfaces/factory-store.js";
import type { Timestamp } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { SqlRunOutputStore } from "./run-output.js";

const TABLE = "controller_activity";
/** The migration runner's record (src/state MIGRATIONS_TABLE), named here: the store reads no runtime value of src/state (kinds R1). */
const MIGRATIONS = "runtime_schema_migrations";
const DAY_MS = 86_400_000;

/** Days a `controller_activity` row is kept (owner answer, 2026-11-26): the retention pass's history class deletes older rows. */
export const ACTIVITY_RETENTION_DAYS = 30;

/** The kinds the store writes itself; units write the others (src/controller/background-jobs.ts activityOf). */
type StoreKind = Extract<ActivityKind, "lease_expiry" | "retention" | "schedule_run" | "restart" | "migration">;
/** Their actor IDs: the store may not import the controller's list (kinds R1), so the type holds each to it. */
export const STORE_ACTORS = {
  lease_expiry: "system:reaper", retention: "system:retention", schedule_run: "system:schedule", restart: "system:supervisor", migration: "system:migrate",
} as const satisfies { [K in StoreKind]: ActorOf<K> };

/** A row of `kind` with its job's actor ID. */
export const activityOf = (kind: StoreKind, a: Omit<NewActivity, "kind" | "actor_id">): NewActivity => ({ actor_id: STORE_ACTORS[kind], kind, ...a });

// The reference formats (the controller's transcriptRef and logRef give the same text: tests/background-jobs.test.ts).
/** A run's transcript path, as the dashboard's transcript route serves it. */
export const transcriptRef = (work_item_id: string, run_id: string): string => `/api/v1/items/${work_item_id}/runs/${run_id}/transcript`;
/** A log reference: the component's log and the message of the line the action wrote. */
export const logRef = (component: string, message: string): string => `log:${component}:${message}`;
/** A schedule's run list, as the dashboard's schedules API serves it, with each run's recorded output. */
export const scheduleRunsRef = (schedule_id: string): string => `/api/v1/schedules/runs?schedule=${encodeURIComponent(schedule_id)}`;


/** Inserts one row at `now` on `db` (a transaction's executor, so it commits or rolls back with its change). */
export async function insertActivity(db: SqlExecutor, now: Timestamp, a: NewActivity): Promise<Activity> {
  const [row] = await db.all(`INSERT INTO ${TABLE} (actor_id, kind, subject, outcome, reason, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, [
    a.actor_id, a.kind, a.subject, a.outcome, a.reason, a.ref, now,
  ]);
  return rowToActivity(row!);
}

export async function listActivity(db: SqlExecutor, opts: { kind?: string; limit?: number } = {}): Promise<Activity[]> {
  const where = opts.kind === undefined ? "" : " WHERE kind = ?";
  const limit = Math.max(0, Math.floor(opts.limit ?? 200));
  const rows = await db.all(`SELECT * FROM ${TABLE}${where} ORDER BY seq DESC LIMIT ${limit}`, opts.kind === undefined ? [] : [opts.kind]);
  return rows.map(rowToActivity);
}

const EXPIRY_OUTCOME: Record<AbandonedAttempt["outcome"], string> = {
  queued: "requeued", failed: "failed", cancelled: "cancelled",
};

/** One `lease_expiry` row per run the reaper moved, on its transaction's executor, linking the run's transcript. */
export async function leaseExpiryActivity(tx: SqlExecutor, now: Timestamp, moved: readonly AbandonedAttempt[], max_attempts: number): Promise<void> {
  for (const a of moved) {
    const why = a.outcome === "cancelled" ? "its item is closed"
      : a.outcome === "queued" ? `attempt ${a.attempt} of ${max_attempts}, retried`
      : a.attempt >= max_attempts ? `attempt ${a.attempt} was the last of ${max_attempts}` : "an interactive session is never requeued";
    await insertActivity(tx, now, activityOf("lease_expiry", {
      subject: a.run_id, outcome: EXPIRY_OUTCOME[a.outcome], ref: transcriptRef(a.work_item_id, a.run_id),
      reason: `the run's lease expired with no heartbeat (last at ${a.ended_at ?? "never"}); ${why}`,
    }));
  }
}

/** The retention classes, as each Activity row's subject names them. */
export type RetentionClass = "outbox" | "commands" | "history";

/**
 * One retention batch (`prune`, on the transaction's executor) and, when it deleted any row, its Activity row with
 * the counts by table, in one transaction: a rolled-back batch leaves no row, and a rerun that deletes nothing writes none.
 */
export function prunedWithActivity(
  db: SqlDriver, now: () => Timestamp, cls: RetentionClass, older_than_ms: number, prune: (tx: SqlExecutor) => Promise<Record<string, number>>,
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const counts = await prune(tx);
    const deleted = Object.entries(counts).filter(([, n]) => n > 0);
    if (deleted.length > 0) {
      const days = Math.round(older_than_ms / DAY_MS);
      await insertActivity(tx, now(), activityOf("retention", {
        subject: cls, outcome: "deleted", ref: logRef("controller", "retention pass"),
        reason: `${cls} rows older than ${days} day${days === 1 ? "" : "s"} (retention): ${deleted.map(([t, n]) => `${t} ${n}`).join(", ")}`,
      }));
    }
    return counts;
  });
}

/**
 * Runs the driver's migrations, then writes one `migration` row per migration this call applied, with its reason. None
 * on a fresh database (no migration recorded before): building it is not a change to stored data, and past
 * migrations get no row. The rows are written after the migrations commit; a migration runs outside any one transaction.
 * `via` names the path that applied them: a store open, or `npm run migrate` (the only path for breaking migrations).
 */
export async function migrateWithActivity(db: SqlDriver, now: () => Timestamp, via: "open" | "npm run migrate"): Promise<void> {
  const applied = async () => (await db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [MIGRATIONS])).length === 0
    ? [] : db.all(`SELECT id, component, change_kind FROM ${MIGRATIONS} ORDER BY id`);
  const before = new Set((await applied()).map((r) => String(r.id)));
  await db.migrate();
  if (before.size === 0) return;
  const added = (await applied()).filter((r) => !before.has(String(r.id)));
  if (added.length === 0) return;
  await db.transaction(async (tx) => {
    for (const r of added) {
      await insertActivity(tx, now(), activityOf("migration", {
        subject: String(r.id), outcome: "applied", ref: logRef("store", "migration applied"),
        reason: `${String(r.change_kind)} migration of ${String(r.component)}, pending in this revision, applied ${via === "open" ? "when the store opened" : "by npm run migrate"}`,
      }));
    }
  });
}

/** ActivityStore over a SqlDriver, in the store's class chain so its methods add no line to sql-factory-store.ts. */
export class SqlActivityStore extends SqlRunOutputStore implements ActivityStore {
  constructor(db: SqlDriver, private readonly activityStamp: () => Timestamp) {
    super(db, activityStamp);
  }

  recordActivity(a: NewActivity): Promise<Activity> {
    return insertActivity(this.db, this.activityStamp(), a);
  }

  listActivity(opts: { kind?: string; limit?: number } = {}): Promise<Activity[]> {
    return listActivity(this.db, opts);
  }
}

function rowToActivity(row: Row): Activity {
  return {
    seq: Number(row.seq), actor_id: String(row.actor_id), kind: String(row.kind), subject: String(row.subject),
    outcome: String(row.outcome), reason: String(row.reason), ref: row.ref == null ? null : String(row.ref), at: String(row.at) as Timestamp,
  };
}
