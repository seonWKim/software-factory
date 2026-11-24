// The Routines page: GET /api/v1/routines (useRoutines) and the writes under /api/v1/routines (postRoutine: add, edit,
// pause, resume and delete), as src/ui/routines-api.ts answers them (design 08-routines, 09-dashboard-routines).

import { t } from "../i18n/index.js";
import { postJson, useApi } from "./client.js";
import { API, type RoutineVerb } from "./routes.js";

export const ROUTINE_CADENCE_KINDS = ["interval", "daily", "weekly", "cron"] as const;
export type RoutineCadenceKind = (typeof ROUTINE_CADENCE_KINDS)[number];

/** One stored routine. `paused`: no run is due; a trigger routine has `schedule` null and `next_due_at` null. */
export interface RoutineRow {
  id: string;
  name: string;
  instruction: string;
  url: string | null;
  schedule: { kind: RoutineCadenceKind; spec: string } | null;
  zone: string;
  trigger: "merge" | null;
  run_cap_usd: number | null;
  daily_cap_usd: number | null;
  paused: boolean;
  next_due_at: string | null;
  last_run_at: string | null;
}

/** The fields an add or an edit sends; an edit sends only those it changes. */
export interface RoutineFields {
  name?: string;
  instruction?: string;
  url?: string | null;
  schedule?: { kind: RoutineCadenceKind; spec: string } | null;
  zone?: string;
  trigger?: "merge" | null;
  run_cap_usd?: number | null;
  daily_cap_usd?: number | null;
}

/** Every routine, oldest first, polled like the other reads. */
export const useRoutines = () => useApi<{ routines: RoutineRow[] }>(API.routines);

/** POST one routine write; a refusal (not the owner, the core's reason) comes back as `{ ok: false, error }`. */
export async function postRoutine(token: string, verb: RoutineVerb, id: string, fields: RoutineFields = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.routineWrite(verb), token, { id, ...fields });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
