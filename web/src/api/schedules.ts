// The Schedules page: GET /api/v1/schedules (useSchedules), GET /api/v1/schedules/runs?schedule=<id> (useScheduleRuns)
// and the writes under /api/v1/schedules (postSchedule: add, edit, pause, resume, run and delete), as src/ui/schedules-api.ts
// answers them (design 08-schedules, 09-dashboard-schedules).

import { t } from "../i18n/index.js";
import { postJson, useApi } from "./client.js";
import { API, type ScheduleVerb } from "./routes.js";

export const CADENCE_KINDS = ["interval", "daily", "weekly", "cron"] as const;
export type CadenceKind = (typeof CADENCE_KINDS)[number];
export const ACTION_KINDS = ["build", "agent", "feedback"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** One stored schedule. `next_due_at` null: paused. */
export interface ScheduleRow {
  id: string;
  title: string;
  cadence: { kind: CadenceKind; spec: string };
  zone: string;
  next_due_at: string | null;
  running_since: string | null;
  skip_when_busy: boolean;
  /** What a due occurrence does: `settings.body` for build, `settings.prompt` for agent and feedback. */
  action: { kind: ActionKind; settings: Record<string, unknown> } | null;
  token_cap: number | null;
}

/** One claimed occurrence of a schedule. */
export interface ScheduleRunRow {
  schedule_id: string;
  /** The slot it was due for. */
  occurrence_at: string;
  outcome: "fired" | "refused" | "skipped" | "checkpoint" | "rejected";
  recorded_at: string;
  output?: string;
  tokens?: number;
  cost_usd?: number;
}

/** The fields an add or an edit sends (the CLI's flags); an edit sends only those it changes. */
export interface ScheduleFields {
  title?: string;
  cadence?: string;
  spec?: string;
  zone?: string;
  action?: string;
  body?: string;
  skip_when_busy?: boolean;
  token_cap?: number;
}

/** Every schedule, polled like the other reads. */
export const useSchedules = () => useApi<{ schedules: ScheduleRow[] }>(API.schedules);

/** One schedule's runs, oldest first, polled. */
export const useScheduleRuns = (id: string) => useApi<{ runs: ScheduleRunRow[] }>(API.scheduleRuns(id));

/** The text of a schedule's action: a build's body, an agent's or feedback's prompt. */
export const actionText = (s: Pick<ScheduleRow, "action">): string => String(s.action?.settings.body ?? s.action?.settings.prompt ?? "");

/** POST one schedule write; a refusal (not the owner, the core's reason) comes back as `{ ok: false, error }`. */
export async function postSchedule(token: string, verb: ScheduleVerb, id: string, fields: ScheduleFields = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.scheduleWrite(verb), token, { id, ...fields });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
