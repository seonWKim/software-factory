// The retention deletes (design 08-retention), kept out of sql-factory-store.ts so that file stays within its line
// budget. Each class deletes a bounded batch per table: a select of keys (SQLite has no DELETE ... LIMIT), then a
// delete by key with the guards checked again, so a second pass on the same rows deletes nothing. Cutoffs come from
// the store's clock, as timestamps.

import type { Timestamp } from "../../../core/types.js";
import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { COMMANDS_CURSOR } from "../../../inbound/index.js";
import type { SqlDriver, SqlValue } from "../../../state/index.js";

/** `?, ?, ...` for `n` bound parameters (the store's lists use it too). */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** Delivered outbox rows created before `before`; an undelivered row stays at any age. */
export async function pruneDeliveredOutbox(db: SqlDriver, before: Timestamp, limit: number): Promise<Record<string, number>> {
  return { outbound_intents: await prune(db, "outbound_intents", ["seq"], "delivered_at IS NOT NULL AND created_at < ?", [before], limit) };
}

/**
 * Command rows created before `before` that the controller has read (seq at or below the commands cursor), that are
 * not waiting for the CLI mirror and, for an app request, that are handled. A request from before the merge (D7)
 * also waits until its app:<seq> command row is gone.
 */
export async function pruneHandledCommands(db: SqlDriver, before: Timestamp, limit: number): Promise<Record<string, number>> {
  const guard =
    "seq <= ? AND created_at < ? AND NOT (mirror = 1 AND mirrored_at IS NULL) AND (origin <> 'app' OR legacy_table = 'command_inbox' OR handled_at IS NOT NULL)";
  // The legacy check is in the select only (MySQL's DELETE cannot name its own table in a subquery); a gone row never returns.
  const own = db.dialect.name === "mysql" ? "CONCAT('app:', inbound_commands.legacy_seq)" : "'app:' || inbound_commands.legacy_seq";
  const legacy = ` AND (legacy_table IS NULL OR legacy_table <> 'app_command_requests' OR NOT EXISTS (SELECT 1 FROM inbound_commands c WHERE c.command_key = ${own}))`;
  const [cursor] = await db.all("SELECT value FROM inbound_cursors WHERE name = ?", [COMMANDS_CURSOR]);
  const params = [Number(cursor?.value ?? 0), before];
  return { inbound_commands: await prune(db, "inbound_commands", ["seq"], guard + legacy, params, limit, guard) };
}

/**
 * Claim decisions, host sleeps and alerts from before `before`. A claim decision of a queued or running run stays at
 * any age (approveClaimHold and the hold timer read it); an alert inside the alarm dedupe window stays too.
 */
export async function pruneRecords(db: SqlDriver, before: Timestamp, now: Timestamp, limit: number): Promise<Record<string, number>> {
  const active = "NOT EXISTS (SELECT 1 FROM worker_runs r WHERE r.id = controller_claim_decisions.run_id AND r.status IN ('queued', 'running'))";
  const open = new Date(Date.parse(now) - ALERT_DEDUPE_MS).toISOString();
  return {
    controller_claim_decisions: await prune(db, "controller_claim_decisions", ["run_id"], `at < ? AND ${active}`, [before], limit),
    worker_host_sleeps: await prune(db, "worker_host_sleeps", ["worker_id", "woke_at"], "woke_at < ?", [before], limit),
    controller_alerts: await prune(db, "controller_alerts", ["id"], "created_at < ? AND created_at < ?", [before, open], limit),
  };
}

/** Deletes at most `limit` rows of `table` matching `where`, by key, checking `recheck` again in the delete. */
async function prune(
  db: SqlDriver, table: string, keys: string[], where: string, params: SqlValue[], limit: number, recheck = where,
): Promise<number> {
  const order = keys.join(", ");
  const rows = await db.all(`SELECT ${order} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${Math.max(0, Math.floor(limit))}`, params);
  if (rows.length === 0) return 0;
  const match =
    keys.length === 1 ? `${keys[0]} IN (${placeholders(rows.length)})` : rows.map(() => `(${keys.map((k) => `${k} = ?`).join(" AND ")})`).join(" OR ");
  const keyed = rows.flatMap((r) => keys.map((k) => r[k] as SqlValue));
  return db.run(`DELETE FROM ${table} WHERE (${match}) AND ${recheck}`, [...keyed, ...params]);
}
