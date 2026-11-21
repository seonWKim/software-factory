// The pauses and the supervisor: GET /api/v1/pauses, POST /api/v1/pauses/resume (postResume), GET /api/v1/supervisor,
// POST /api/v1/supervisor (postSupervisor: Start, Restart now) and POST /api/v1/migrate (postMigrate: Migrate now).

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import { API } from "./routes.js";

/**
 * One claim pause in effect (design §5 Restarts). `ends_at`: for model_stall, the next probe time; null for `owner`
 * (Stop all agents), which holds until resumed.
 */
export interface PauseRow {
  name: string;
  ends_at: string | null;
  /** When the agents were stopped (`owner`) or a model stall began; absent for the pauses that have no start time. */
  since?: string | null;
}

/** One of Migrate now, Start and Restart now: offered, or why not in plain words. */
export interface SupervisorOffer {
  offered: boolean;
  reason: string | null;
}

/** `/api/v1/supervisor`: which supervisor actions the page may offer (404 when the server has none of them). */
export interface SupervisorView {
  live: boolean;
  state: string | null;
  migrate: SupervisorOffer;
  start: SupervisorOffer;
  restart: SupervisorOffer;
  csrf_token: string;
}

/** Migrate now's dry run: the pending steps and each line `npm run migrate -- --dry-run` would print. */
export interface MigrateDryRun {
  pending: string[];
  lines: string[];
  ok: boolean;
}

/** `/api/v1/pauses`: the pauses in effect; `csrf_token` is null when the server has no resume route. */
export interface PausesView {
  pauses: PauseRow[];
  csrf_token: string | null;
}

/** POST /api/v1/pauses/resume: ends one pause now. A refusal (403, 400, …) comes back as `{ ok: false, error }`. */
export async function postResume(token: string, name: string): Promise<{ ok: true; ended: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ ended?: boolean; error?: string }>(API.resume, token, { name });
  if (r.ok) return { ok: true, ended: r.value.ended === true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/**
 * POST /api/v1/migrate: without `confirm` the dry run (nothing filed), with it the drain, apply and start-or-cancel
 * sequence, started in the background. A refusal (no live supervisor, a migration under way, …) comes back as `{ ok: false, error }`.
 */
export async function postMigrate(token: string, confirm: boolean): Promise<{ ok: true; dry_run: MigrateDryRun | null } | { ok: false; error: string }> {
  const r = await postJson<{ dry_run?: MigrateDryRun; error?: string }>(API.migrate, token, confirm ? { confirm: true } : {});
  if (r.ok) return { ok: true, dry_run: r.value.dry_run ?? null };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/supervisor: Start or Restart now, confirmed. A refusal comes back as `{ ok: false, error }`. */
export async function postSupervisor(token: string, action: "start" | "restart"): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.supervisor, token, { action, confirm: true });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
