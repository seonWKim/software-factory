// Alarm dismissal on the dashboard (design 05-alarms): POST /api/v1/alarms/dismiss with `{ "alert_id": <id> }` hides
// that alarm until its pattern alerts again, as `factory alarm dismiss <id>` does (both call the store's dismissAlert
// with the acting user's ID). The request guards (Host, Origin, Content-Type, CSRF token) run in write-routes.ts
// before dismissPost is reached; then the owner check of POST /api/v1/pauses/resume: the page's factory user must be
// allowed `approve_spec` on the configured project. Only then is the store written. No hold is lifted.

import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";

export const ALARM_DISMISS_PATH = "/api/v1/alarms/dismiss";

/** POST /api/v1/alarms/dismiss, after the request guards. */
export async function dismissPost(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const alert_id = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).alert_id : undefined;
  if (typeof alert_id !== "string" || alert_id === "") return { status: 400, value: { error: "alert_id must be an alert's id" } };
  const user = await p.principal();
  if (user === null) {
    return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  }
  const decision = await p.authorize(user);
  if (!decision.allow) {
    return { status: 403, value: { error: `Dismissing needs write permission (approve_spec): ${decision.reason}. As the owner, run \`factory alarm dismiss ${alert_id}\`.` } };
  }
  const r = await d.store.dismissAlert(alert_id, user);
  if (r === null) return { status: 404, value: { error: `No alert ${alert_id}.` } };
  p.log.info(r.dismissed ? "alarm dismissed" : "alarm dismiss: already dismissed", { alert_id, actor: user, dismissed: r.dismissed });
  return { status: 200, value: { alert_id, pattern_key: r.pattern_key, dismissed: r.dismissed, dismissed_at: r.dismissed_at } };
}
