// Claim pauses on the dashboard (design §5 Restarts and §9, issue #291). GET /api/v1/pauses lists each pause in
// effect with when it ends; POST /api/v1/pauses/resume ends one, as `factory resume <name>` does (endPause in
// src/resume-cmd.ts, so both write the same log line). The request guards (Host, Origin, Content-Type, CSRF
// token) run in server.ts before resumePause is reached; then the owner check: the page's factory user must be
// allowed `approve_spec` on the configured project. Only then is the store written.

import type { Logger } from "../core/log.js";
import type { Timestamp, UserId } from "../core/types.js";
import type { AuthDecision } from "../interfaces/auth-provider.js";
import { RESUMABLE_PAUSES, type ResumablePause, endPause, isResumablePause } from "../resume-cmd.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";

export const PAUSES_PATH = "/api/v1/pauses";
export const RESUME_PATH = "/api/v1/pauses/resume";

/** What the resume route needs beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiPauses {
  /** The factory user acting from this page (a linked local account, else `cli_user`), or null when there is none. */
  principal(): Promise<UserId | null>;
  /** The owner check: `approve_spec` on the configured project, asked of the local grants only (no forge call). */
  authorize(user: UserId): Promise<AuthDecision>;
  /** The per-process token, the Settings page's own; POST must send it in x-csrf-token. */
  csrfToken: string;
  log: Logger;
}

/** The UI's dependencies with the pause routes. Absent `pauses`: the list is read-only and POST is a 405. */
export type PauseDeps = UiDeps & { pauses?: UiPauses };

export interface PauseView {
  name: ResumablePause;
  /** When it ends by itself; for `model_stall`, the next probe time (it ends when a probe answers). */
  ends_at: Timestamp;
}

/** Every pause in effect, in RESUMABLE_PAUSES order. Store reads only. */
export async function activePauses(d: Pick<UiDeps, "store">): Promise<PauseView[]> {
  const out: PauseView[] = [];
  for (const name of RESUMABLE_PAUSES) {
    const ends_at = await d.store.getClaimPause(name);
    if (ends_at !== null) out.push({ name, ends_at });
  }
  return out;
}

/** GET /api/v1/pauses: the pauses and, when the resume route is wired, the CSRF token it needs. */
export async function readPauses(d: PauseDeps): Promise<ApiResult> {
  return { status: 200, value: { pauses: await activePauses(d), csrf_token: d.pauses?.csrfToken ?? null } };
}

/** POST /api/v1/pauses/resume with `{ "name": <pause> }`, after the request guards. */
export async function resumePause(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const name = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).name : undefined;
  if (!isResumablePause(name)) {
    return { status: 400, value: { error: `name must be one of ${RESUMABLE_PAUSES.join(", ")}` } };
  }
  const user = await p.principal();
  if (user === null) {
    return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  }
  const decision = await p.authorize(user);
  if (!decision.allow) {
    return { status: 403, value: { error: `Resuming needs write permission (approve_spec): ${decision.reason}. Or run \`factory resume ${name}\`.` } };
  }
  const r = await endPause({ store: d.store, actor: user, log: p.log }, name);
  return { status: 200, value: { name, ended: r.ended, pauses: await activePauses(d) } };
}
