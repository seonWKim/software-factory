// The Health panel's Run now (design §7 and §9, issue #508): POST /api/v1/improve/run queues one manual improve
// run of the configured project through enqueueImprove, as `factory improve` does. The request guards (Host,
// Origin, Content-Type, CSRF token) run in server.ts first; then the approver check, the pause route's: the page's
// factory user must be allowed `approve_spec` on the project, asked of the local grants only (no forge call). A
// run already queued or running refuses the request; only then is the store written.

import { enqueueImprove, pendingImprove } from "../core/improver.js";
import type { UserId } from "../core/types.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import type { UiSettings } from "./settings-api.js";

export const IMPROVE_RUN_PATH = "/api/v1/improve/run";

/** The route's wiring: the pause route's user and owner check, and the Settings route's store-only project. */
export type ImproveRunDeps = PauseDeps & { pauses: UiPauses; settings: UiSettings };

/** Whether Run now is wired: both the owner check and the project resolver are there. */
export function improveRunWired(d: PauseDeps): d is ImproveRunDeps {
  return d.pauses !== undefined && d.settings !== undefined;
}

/** The page's user when they may run it, else why not: no user, or no `approve_spec`. */
async function approver(p: UiPauses): Promise<{ user: UserId } | { error: string }> {
  const user = await p.principal();
  if (user === null) return { error: "No factory user acts from this page: link your local account or set cli_user." };
  const decision = await p.authorize(user);
  return decision.allow ? { user } : { error: `Running an improve run needs write permission (approve_spec): ${decision.reason}. Or run \`factory improve\`.` };
}

/** The Health panel's Run now button: its CSRF token when the route is wired and the page's user may approve, else null. */
export async function runNowButton(d: PauseDeps): Promise<{ csrfToken: string } | null> {
  if (!improveRunWired(d) || "error" in (await approver(d.pauses))) return null;
  return { csrfToken: d.pauses.csrfToken };
}

/** POST /api/v1/improve/run, after the request guards: the approver check, then one manual run, its ID returned. */
export async function runImproveNow(d: ImproveRunDeps): Promise<ApiResult> {
  const who = await approver(d.pauses);
  if ("error" in who) return { status: 403, value: { error: who.error } };
  const project = await d.settings.resolveProject();
  if (!project) return { status: 409, value: { error: "No project is stored yet: start the factory once first." } };
  const pending = await pendingImprove(d.store, project.key);
  if (pending) return { status: 409, value: { error: `An improve run is already ${pending.status} (${pending.id}).`, run_id: pending.id } };
  const { run } = await enqueueImprove(d, project.key, "manual");
  d.pauses.log.info("improve run queued", { run_id: run.id, actor: who.user, trigger: "manual" });
  return { status: 200, value: { run_id: run.id } };
}
