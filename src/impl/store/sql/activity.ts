// The Activity record (design 08-schedules-actions): `controller_activity`, one row per autonomous action. Every
// write here takes the caller's executor, so a store method writes the row in the transaction of its change: the
// reaper's lease expiry (expireLeases), a retention batch (prunedWithActivity), a schedule claim (schedules.ts), an
// auto-grant (a transition's `activity`). A migration's row follows the migrations an open or `npm run migrate`
// applied (migrationActivity); past actions get none.

import { type ActivityKind, activityActor } from "../../../controller/background-jobs.js";
import type { Activity, NewActivity } from "../../../interfaces/factory-store.js";
import type { Timestamp } from "../../../core/types.js";
import { MIGRATIONS_TABLE, tableExists, type Row, type SqlDriver, type SqlExecutor } from "../../../state/index.js";

const TABLE = "controller_activity";
const DAY_MS = 86_400_000;

/** A run's transcript path, as the dashboard's transcript route serves it. */
export const transcriptRef = (work_item_id: string, run_id: string): string => `/items/${work_item_id}/runs/${run_id}/transcript`;
/** A log reference: the component's log and the message of the line the action wrote. */
export const logRef = (component: string, message: string): string => `log:${component}:${message}`;

/** Inserts one row at `now` on `db` (a transaction's executor, so it commits or rolls back with its change). */
export async function insertActivity(db: SqlExecutor, now: Timestamp, a: NewActivity): Promise<Activity> {
  const [row] = await db.all(`INSERT INTO ${TABLE} (actor_id, kind, subject, outcome, reason, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, [
    a.actor_id, a.kind, a.subject, a.outcome, a.reason, a.ref, now,
  ]);
  return rowToActivity(row!);
}

/** A row of `kind` with its job's actor ID. */
export const activityOf = (kind: ActivityKind, a: Omit<NewActivity, "kind" | "actor_id">): NewActivity => ({ actor_id: activityActor(kind), kind, ...a });

export async function listActivity(db: SqlExecutor, opts: { kind?: string; limit?: number } = {}): Promise<Activity[]> {
  const where = opts.kind === undefined ? "" : " WHERE kind = ?";
  const limit = Math.max(0, Math.floor(opts.limit ?? 200));
  const rows = await db.all(`SELECT * FROM ${TABLE}${where} ORDER BY seq DESC LIMIT ${limit}`, opts.kind === undefined ? [] : [opts.kind]);
  return rows.map(rowToActivity);
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

/** The ids of the timestamped migrations applied so far; null on a store with none (a fresh database). Read-only. */
export async function appliedMigrations(db: SqlExecutor): Promise<Set<string> | null> {
  if (!(await tableExists({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) }, MIGRATIONS_TABLE))) return null;
  const ids = (await db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((r) => String(r.id));
  return ids.length === 0 ? null : new Set(ids);
}

/**
 * One `migration` row per migration applied since `before` (appliedMigrations' read before the migrations ran), with
 * `how` in its reason. None on a fresh database (`before` null): building it is not a change to stored data.
 */
export async function migrationActivity(db: SqlDriver, now: Timestamp, before: Set<string> | null, how: string): Promise<void> {
  if (before === null) return;
  const rows = await db.all(`SELECT id, component, change_kind FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  const added = rows.filter((r) => !before.has(String(r.id)));
  if (added.length === 0) return;
  await db.transaction(async (tx) => {
    for (const r of added) {
      await insertActivity(tx, now, activityOf("migration", {
        subject: String(r.id), outcome: "applied", ref: null,
        reason: `${String(r.change_kind)} migration of ${String(r.component)} pending in this revision, applied ${how}`,
      }));
    }
  });
}

function rowToActivity(row: Row): Activity {
  return {
    seq: Number(row.seq), actor_id: String(row.actor_id), kind: String(row.kind), subject: String(row.subject),
    outcome: String(row.outcome), reason: String(row.reason), ref: row.ref == null ? null : String(row.ref), at: String(row.at) as Timestamp,
  };
}
