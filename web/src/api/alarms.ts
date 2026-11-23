// Alarm dismissal (design 05-alarms, 09-dashboard-tasks-needs): POST /api/v1/alarms/dismiss (postDismissAlarm), the
// route of src/ui/alarm-api.ts, sent with the pauses' CSRF token.

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";

/** POST /api/v1/alarms/dismiss with `{ alert_id }`: hides that alarm until its pattern alerts again. */
export const ALARM_DISMISS_PATH = "/api/v1/alarms/dismiss";

/** Dismisses one alarm. A refusal (403, 404, …) comes back as `{ ok: false, error }`. */
export async function postDismissAlarm(token: string, alertId: string): Promise<{ ok: true; dismissed: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ dismissed?: boolean; error?: string }>(ALARM_DISMISS_PATH, token, { alert_id: alertId });
  if (r.ok) return { ok: true, dismissed: r.value.dismissed === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
