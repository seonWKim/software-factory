// Alerts (design 05-alarms): the store methods over `controller_alert_patterns` (one row per pattern: its last alert
// and its last dismissal, the dedupe) and `controller_alerts` (the record), kept out of sql-factory-store.ts so that
// file stays within its line budget. Every write is conditional on the pattern's row, so replicas writing one
// pattern at once store one alert and one dismissal.

import type { AlertDismissal } from "../../../core/alarms.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Alert, NewAlert } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { newId } from "./rows.js";

/**
 * Stores `input` unless its pattern alerted after `window_start`. A dismissal at or after the pattern's last alert
 * lifts the window; the winner moves `last_alert_at` to `now`, past the dismissal, so only one write wins.
 */
export async function recordAlert(db: SqlDriver, now: Timestamp, input: NewAlert, window_start: Timestamp): Promise<{ created: true; alert: Alert } | { created: false }> {
  return db.transaction(async (tx) => {
    let due: boolean;
    try {
      await tx.run("INSERT INTO controller_alert_patterns (pattern_key, last_alert_at) VALUES (?, ?)", [input.pattern_key, now]);
      due = true;
    } catch (err) {
      if (!db.isDuplicateKey(err)) throw err;
      due = (await tx.run(
        "UPDATE controller_alert_patterns SET last_alert_at = ? WHERE pattern_key = ? AND (last_alert_at <= ? OR (dismissed_at >= last_alert_at AND last_alert_at < ?))",
        [now, input.pattern_key, window_start, now],
      )) === 1;
    }
    if (!due) return { created: false as const };
    const alert: Alert = { ...input, id: newId("al"), created_at: now };
    await tx.run(
      "INSERT INTO controller_alerts (id, pattern, pattern_key, error_code, count, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [alert.id, alert.pattern, alert.pattern_key, alert.error_code, alert.count, alert.detail, alert.created_at],
    );
    return { created: true as const, alert };
  });
}

/** The newest alerts first (created_at, then id, both descending), each with its pattern's dismissal when it has one. */
export async function listAlerts(db: SqlDriver, limit: number): Promise<Alert[]> {
  // limit is an integer computed here, inlined as the other paged reads do.
  const rows = await db.all(
    `SELECT a.*, p.dismissed_at FROM controller_alerts a LEFT JOIN controller_alert_patterns p ON p.pattern_key = a.pattern_key
     ORDER BY a.created_at DESC, a.id DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
  );
  return rows.map(rowToAlert);
}

/** Dismisses the pattern of `alert_id` at `now` by `actor`, unless it was dismissed since its last alert; null: no such alert. */
export async function dismissAlert(
  db: SqlDriver, now: Timestamp, alert_id: string, actor: UserId,
): Promise<{ pattern_key: string; dismissed: boolean; dismissed_at: Timestamp } | null> {
  return db.transaction(async (tx) => {
    const [alert] = await tx.all("SELECT pattern_key FROM controller_alerts WHERE id = ?", [alert_id]);
    if (!alert) return null;
    const pattern_key = String(alert.pattern_key);
    // Conditional: one dismissal per alert of the pattern; a second (or a replica's) keeps the first's time and actor.
    const dismissed = (await tx.run(
      "UPDATE controller_alert_patterns SET dismissed_at = ?, dismissed_by = ? WHERE pattern_key = ? AND (dismissed_at IS NULL OR dismissed_at < last_alert_at)",
      [now, actor, pattern_key],
    )) === 1;
    const [row] = await tx.all("SELECT dismissed_at FROM controller_alert_patterns WHERE pattern_key = ?", [pattern_key]);
    return { pattern_key, dismissed, dismissed_at: String(row?.dismissed_at ?? now) as Timestamp };
  });
}

/** The patterns dismissed at or after `since`, newest first. */
export async function listAlertDismissals(db: SqlDriver, since: Timestamp): Promise<AlertDismissal[]> {
  const rows = await db.all(
    "SELECT pattern_key, dismissed_at, dismissed_by FROM controller_alert_patterns WHERE dismissed_at >= ? ORDER BY dismissed_at DESC, pattern_key",
    [since],
  );
  return rows.map((r) => ({ pattern_key: String(r.pattern_key), dismissed_at: String(r.dismissed_at) as Timestamp, dismissed_by: String(r.dismissed_by) as UserId }));
}

function rowToAlert(row: Row): Alert {
  return {
    id: row.id as string,
    pattern: row.pattern as Alert["pattern"],
    pattern_key: row.pattern_key as string,
    error_code: row.error_code as string,
    count: Number(row.count),
    detail: (row.detail as string | null) ?? null,
    created_at: row.created_at as Timestamp,
    ...(row.dismissed_at ? { dismissed_at: row.dismissed_at as Timestamp } : {}),
  };
}
