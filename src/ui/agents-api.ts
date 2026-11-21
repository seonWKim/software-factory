// The dashboard's "Stop all agents" (design 05-restart-pauses and 09-dashboard-shell, 2026-11-21): POST
// /api/v1/agents/stop starts the owner pause, as `factory stop` does (stopAgents in src/resume-cmd.ts, so both write
// the same log line and the same pause row). The request guards (Host, Origin, Content-Type, CSRF token) run in
// server.ts first; then the owner check, as Resume now's: the page's factory user must be allowed `approve_spec` on
// the configured project. Only then is the store written. Its undo is Resume now on the owner pause (pause-api.ts).

import { OWNER_PAUSE, stopAgents } from "../resume-cmd.js";
import type { ApiResult } from "./api.js";
import { activePauses, type PauseDeps, type UiPauses } from "./pause-api.js";

export const STOP_PATH = "/api/v1/agents/stop";

/** POST /api/v1/agents/stop with `{}`, after the request guards. */
export async function stopAllAgents(d: PauseDeps, p: UiPauses): Promise<ApiResult> {
  const user = await p.principal();
  if (user === null) {
    return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  }
  const decision = await p.authorize(user);
  if (!decision.allow) {
    return { status: 403, value: { error: `Stopping needs write permission (approve_spec): ${decision.reason}. As the owner, run \`factory stop\`.` } };
  }
  const r = await stopAgents({ store: d.store, actor: user, log: p.log });
  return { status: 200, value: { name: OWNER_PAUSE, stopped: r.stopped, since: r.since, pauses: await activePauses(d) } };
}
