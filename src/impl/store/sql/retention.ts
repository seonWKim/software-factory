// The retention deletes (design 08-retention), kept out of sql-factory-store.ts so that file stays within its line
// budget. Each class deletes a bounded batch per table: a select of keys (SQLite has no DELETE ... LIMIT), then a
// delete by key with the guards checked again, so a second pass on the same rows deletes nothing. Cutoffs come from
// the store's clock, as timestamps. Also the pause history the deletes never touch (design 07-self-improvement).

import type { Timestamp } from "../../../core/types.js";
import type { PauseInterval } from "../../../interfaces/factory-store.js";
import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { PROBE_PAUSES } from "../../../core/policy.js";
import { COMMANDS_CURSOR } from "../../../inbound/index.js";
import { ACTION_INTENT, THREAD_INTENT } from "../../../outbound/index.js";
import type { SqlDriver, SqlExecutor, SqlValue } from "../../../state/index.js";
import { ACTIVITY_RETENTION_DAYS } from "./activity.js";

/** `?, ?, ...` for `n` bound parameters (the store's lists use it too). */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** The newest push_base action of an item stays at any age: getBasePush reads it, and its batch's tries. */
const NOT_LATEST_BASE_PUSH =
  "(action <> 'push_base' OR EXISTS (SELECT 1 FROM outbound_actions n WHERE n.work_item_id = outbound_actions.work_item_id AND n.action = 'push_base' AND n.seq > outbound_actions.seq))";

/** A batch's intent row whose intent (`act_<seq>` or `int_<seq>`) is gone, in a batch that is sent or gone. */
const INTENT_GONE = [[ACTION_INTENT, "outbound_actions"], [THREAD_INTENT, "outbound_intents"]]
  .map(([prefix, table]) => {
    const id = "outbound_batch_intents.intent_id";
    return `NOT EXISTS (SELECT 1 FROM ${table} x WHERE SUBSTR(${id}, 1, ${prefix!.length}) = '${prefix}' AND x.seq = CAST(SUBSTR(${id}, ${prefix!.length + 1}) AS INTEGER))`;
  })
  .concat("NOT EXISTS (SELECT 1 FROM outbound_batches b WHERE b.id = outbound_batch_intents.batch_id AND b.state <> 'sent')")
  .join(" AND ");

/**
 * Delivered outbox rows created before `before` (thread entries and actions, but an item's newest push_base), then
 * the batch rows no kept intent uses: an intent row whose intent is gone, and a sent batch with no intent row left.
 * An undelivered row stays at any age, and so does every batch row of a kept intent.
 */
export async function pruneDeliveredOutbox(db: SqlExecutor, before: Timestamp, limit: number): Promise<Record<string, number>> {
  const delivered = "delivered_at IS NOT NULL AND created_at < ?";
  return {
    outbound_intents: await prune(db, "outbound_intents", ["seq"], delivered, [before], limit),
    // The checks that read their own table are in the select only (as pruneHandledCommands' legacy check).
    outbound_actions: await prune(db, "outbound_actions", ["seq"], `${delivered} AND ${NOT_LATEST_BASE_PUSH}`, [before], limit, delivered),
    outbound_batch_intents: await prune(db, "outbound_batch_intents", ["seq"], INTENT_GONE, [], limit),
    outbound_batches: await prune(
      db, "outbound_batches", ["seq"],
      "state = 'sent' AND sent_at < ? AND NOT EXISTS (SELECT 1 FROM outbound_batch_intents i WHERE i.batch_id = outbound_batches.id)", [before], limit,
    ),
  };
}

/**
 * Command rows created before `before` that the controller has read (seq at or below the commands cursor), that are
 * not waiting for the CLI mirror and, for an app request, that are handled. A request from before the merge (D7)
 * also waits until its app:<seq> command row is gone.
 */
export async function pruneHandledCommands(db: SqlExecutor, before: Timestamp, limit: number): Promise<Record<string, number>> {
  const guard =
    "seq <= ? AND created_at < ? AND NOT (mirror = 1 AND mirrored_at IS NULL) AND (origin <> 'app' OR legacy_table = 'command_inbox' OR handled_at IS NOT NULL)";
  // The legacy check is in the select only; a gone row never returns.
  const own = "'app:' || inbound_commands.legacy_seq";
  const legacy = ` AND (legacy_table IS NULL OR legacy_table <> 'app_command_requests' OR NOT EXISTS (SELECT 1 FROM inbound_commands c WHERE c.command_key = ${own}))`;
  const [cursor] = await db.all("SELECT value FROM inbound_cursors WHERE name = ?", [COMMANDS_CURSOR]);
  const params = [Number(cursor?.value ?? 0), before];
  return { inbound_commands: await prune(db, "inbound_commands", ["seq"], guard + legacy, params, limit, guard) };
}

/** Whether probe pause `pause` (`model_stall`, `network`) is in effect: its row is after its answered row, whatever the clock says. */
function probeInEffect(pause: string, answeredRow: string): string {
  const answered = `COALESCE((SELECT a.resume_at FROM worker_claim_pauses a WHERE a.name = '${answeredRow}'), '')`;
  return `EXISTS (SELECT 1 FROM worker_claim_pauses p WHERE p.name = '${pause}' AND p.resume_at > ${answered})`;
}

/** A claim pause row that no probe pause in effect needs: a probe pause's three rows stay until a probe answered it. */
const PAUSE_ENDED = Object.entries(PROBE_PAUSES)
  .map(([pause, rows]) => `(name NOT IN ('${pause}', '${rows.since}', '${rows.answered}') OR NOT ${probeInEffect(pause, rows.answered)})`)
  .join(" AND ");

/**
 * The pause history (design 07-self-improvement): one `controller_pause_history` row per ended `model_stall` or `network`
 * pause, append-only and never pruned, unique per (name, started_at) so a pause is stored once and never overwritten.
 * PAUSE_INSERT_ROW takes (name, started_at, ended_at); PAUSE_END_INSERT takes (name, ended_at, its since row's name).
 */
export const PAUSE_INSERT_ROW = "INSERT INTO controller_pause_history (name, started_at, ended_at) VALUES (?, ?, ?)";
export const PAUSE_END_INSERT = "INSERT INTO controller_pause_history (name, started_at, ended_at) SELECT ?, resume_at, ? FROM worker_claim_pauses WHERE name = ?";

/** The pause in effect at `at`: an ended one with started_at <= at < ended_at, else one still in effect whose since row is not after `at`. */
export async function pauseAt(db: SqlDriver, at: Timestamp): Promise<PauseInterval | null> {
  const sql = "SELECT name, started_at, ended_at FROM controller_pause_history WHERE started_at <= ? AND ended_at > ? ORDER BY started_at, name LIMIT 1";
  const [ended] = await db.all(sql, [at, at]);
  if (ended) return { name: ended.name as PauseInterval["name"], started_at: ended.started_at as Timestamp, ended_at: ended.ended_at as Timestamp };
  for (const [pause, rows] of Object.entries(PROBE_PAUSES)) {
    const open = `SELECT resume_at FROM worker_claim_pauses WHERE name = ? AND resume_at <= ? AND ${probeInEffect(pause, rows.answered)}`;
    const [since] = await db.all(open, [rows.since, at]);
    if (since) return { name: pause as PauseInterval["name"], started_at: since.resume_at as Timestamp, ended_at: null };
  }
  return null;
}

/** Passports a live passport (expires after `now`) names as its parent, its parent's parent and so on. */
const LIVE_ANCESTORS =
  "WITH RECURSIVE up (id) AS (SELECT parent_id FROM identity_passports WHERE expires_at > ? AND parent_id IS NOT NULL " +
  "UNION SELECT p.parent_id FROM identity_passports p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL) SELECT id FROM up";

/**
 * History older than `before`: claim decisions, host sleeps, alerts, authz_audit rows and claim pauses that ended;
 * Activity rows older than ACTIVITY_RETENTION_DAYS (30) before `now`, whatever `before` is.
 * A claim decision of a queued or running run stays at any age (approveClaimHold and the hold timer read it); an
 * alert inside the alarm dedupe window stays too; a probe pause in effect stays. Then, by `now`: passports past
 * their expiry (but any ancestor of a live one, so no live passport loses its parent) and revocations past theirs.
 */
export async function pruneHistory(db: SqlExecutor, before: Timestamp, now: Timestamp, limit: number): Promise<Record<string, number>> {
  const active = "NOT EXISTS (SELECT 1 FROM worker_runs r WHERE r.id = controller_claim_decisions.run_id AND r.status IN ('queued', 'running'))";
  const open = new Date(Date.parse(now) - ALERT_DEDUPE_MS).toISOString();
  const activity = new Date(Date.parse(now) - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  return {
    controller_claim_decisions: await prune(db, "controller_claim_decisions", ["run_id"], `at < ? AND ${active}`, [before], limit),
    worker_host_sleeps: await prune(db, "worker_host_sleeps", ["worker_id", "woke_at"], "woke_at < ?", [before], limit),
    controller_alerts: await prune(db, "controller_alerts", ["id"], "created_at < ? AND created_at < ?", [before, open], limit),
    authz_audit: await prune(db, "authz_audit", ["seq"], "at < ?", [before], limit),
    worker_claim_pauses: await prune(db, "worker_claim_pauses", ["name"], `resume_at < ? AND ${PAUSE_ENDED}`, [before], limit, "resume_at < ?"),
    identity_passports: await prune(db, "identity_passports", ["id"], `expires_at <= ? AND id NOT IN (${LIVE_ANCESTORS})`, [now, now], limit, "expires_at <= ?"),
    identity_revocations: await prune(db, "identity_revocations", ["passport_id"], "expires_at <= ?", [now], limit),
    controller_activity: await prune(db, "controller_activity", ["seq"], "at < ?", [activity], limit),
  };
}

/**
 * Deletes at most `limit` rows of `table` matching `where`, by key, checking `recheck` again in the delete. A
 * `recheck` other than `where` is its start: it takes the first of `params`, one per placeholder.
 */
async function prune(
  db: SqlExecutor, table: string, keys: string[], where: string, params: SqlValue[], limit: number, recheck = where,
): Promise<number> {
  const order = keys.join(", ");
  const rows = await db.all(`SELECT ${order} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${Math.max(0, Math.floor(limit))}`, params);
  if (rows.length === 0) return 0;
  const match =
    keys.length === 1 ? `${keys[0]} IN (${placeholders(rows.length)})` : rows.map(() => `(${keys.map((k) => `${k} = ?`).join(" AND ")})`).join(" OR ");
  const keyed = rows.flatMap((r) => keys.map((k) => r[k] as SqlValue));
  const rechecked = params.slice(0, recheck.split("?").length - 1);
  return db.run(`DELETE FROM ${table} WHERE (${match}) AND ${recheck}`, [...keyed, ...rechecked]);
}
