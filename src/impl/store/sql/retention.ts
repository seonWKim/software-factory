// The retention deletes (design 08-retention), kept out of sql-factory-store.ts so that file stays within its line
// budget. Each class deletes a bounded batch per table: a select of keys (SQLite has no DELETE ... LIMIT), then a
// delete by key with the guards checked again, so a second pass on the same rows deletes nothing. Cutoffs come from
// the store's clock, as timestamps.

import type { Timestamp } from "../../../core/types.js";
import { ALERT_DEDUPE_MS } from "../../../core/alarms.js";
import { PROBE_PAUSES } from "../../../core/policy.js";
import { COMMANDS_CURSOR } from "../../../inbound/index.js";
import { ACTION_INTENT, THREAD_INTENT } from "../../../outbound/index.js";
import type { SqlDriver, SqlValue } from "../../../state/index.js";

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
export async function pruneDeliveredOutbox(db: SqlDriver, before: Timestamp, limit: number): Promise<Record<string, number>> {
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
export async function pruneHandledCommands(db: SqlDriver, before: Timestamp, limit: number): Promise<Record<string, number>> {
  const guard =
    "seq <= ? AND created_at < ? AND NOT (mirror = 1 AND mirrored_at IS NULL) AND (origin <> 'app' OR legacy_table = 'command_inbox' OR handled_at IS NOT NULL)";
  // The legacy check is in the select only; a gone row never returns.
  const own = "'app:' || inbound_commands.legacy_seq";
  const legacy = ` AND (legacy_table IS NULL OR legacy_table <> 'app_command_requests' OR NOT EXISTS (SELECT 1 FROM inbound_commands c WHERE c.command_key = ${own}))`;
  const [cursor] = await db.all("SELECT value FROM inbound_cursors WHERE name = ?", [COMMANDS_CURSOR]);
  const params = [Number(cursor?.value ?? 0), before];
  return { inbound_commands: await prune(db, "inbound_commands", ["seq"], guard + legacy, params, limit, guard) };
}

/**
 * A claim pause row that no probe pause in effect needs: a probe pause (`model_stall`, `network`) is in effect while
 * its row is after its answered row, whatever the clock says, so its three rows stay until a probe answered it.
 */
const PAUSE_ENDED = Object.entries(PROBE_PAUSES)
  .map(([pause, rows]) => {
    const answered = `COALESCE((SELECT a.resume_at FROM worker_claim_pauses a WHERE a.name = '${rows.answered}'), '')`;
    const inEffect = `EXISTS (SELECT 1 FROM worker_claim_pauses p WHERE p.name = '${pause}' AND p.resume_at > ${answered})`;
    return `(name NOT IN ('${pause}', '${rows.since}', '${rows.answered}') OR NOT ${inEffect})`;
  })
  .join(" AND ");

/** Passports a live passport (expires after `now`) names as its parent, its parent's parent and so on. */
const LIVE_ANCESTORS =
  "WITH RECURSIVE up (id) AS (SELECT parent_id FROM identity_passports WHERE expires_at > ? AND parent_id IS NOT NULL " +
  "UNION SELECT p.parent_id FROM identity_passports p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL) SELECT id FROM up";

/**
 * History older than `before`: claim decisions, host sleeps, alerts, authz_audit rows and claim pauses that ended.
 * A claim decision of a queued or running run stays at any age (approveClaimHold and the hold timer read it); an
 * alert inside the alarm dedupe window stays too; a probe pause in effect stays. Then, by `now`: passports past
 * their expiry (but any ancestor of a live one, so no live passport loses its parent) and revocations past theirs.
 */
export async function pruneHistory(db: SqlDriver, before: Timestamp, now: Timestamp, limit: number): Promise<Record<string, number>> {
  const active = "NOT EXISTS (SELECT 1 FROM worker_runs r WHERE r.id = controller_claim_decisions.run_id AND r.status IN ('queued', 'running'))";
  const open = new Date(Date.parse(now) - ALERT_DEDUPE_MS).toISOString();
  return {
    controller_claim_decisions: await prune(db, "controller_claim_decisions", ["run_id"], `at < ? AND ${active}`, [before], limit),
    worker_host_sleeps: await prune(db, "worker_host_sleeps", ["worker_id", "woke_at"], "woke_at < ?", [before], limit),
    controller_alerts: await prune(db, "controller_alerts", ["id"], "created_at < ? AND created_at < ?", [before, open], limit),
    authz_audit: await prune(db, "authz_audit", ["seq"], "at < ?", [before], limit),
    worker_claim_pauses: await prune(db, "worker_claim_pauses", ["name"], `resume_at < ? AND ${PAUSE_ENDED}`, [before], limit, "resume_at < ?"),
    identity_passports: await prune(db, "identity_passports", ["id"], `expires_at <= ? AND id NOT IN (${LIVE_ANCESTORS})`, [now, now], limit, "expires_at <= ?"),
    identity_revocations: await prune(db, "identity_revocations", ["passport_id"], "expires_at <= ?", [now], limit),
  };
}

/**
 * Deletes at most `limit` rows of `table` matching `where`, by key, checking `recheck` again in the delete. A
 * `recheck` other than `where` is its start: it takes the first of `params`, one per placeholder.
 */
async function prune(
  db: SqlDriver, table: string, keys: string[], where: string, params: SqlValue[], limit: number, recheck = where,
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
