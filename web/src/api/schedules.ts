// The Schedules page: GET /api/v1/schedules (useSchedules), GET /api/v1/schedules/runs?schedule=<id> (useScheduleRuns),
// GET /api/v1/schedules/suggestions?schedule=<id> (useScheduleSuggestions)
// and the writes under /api/v1/schedules (postSchedule: add, edit, pause, resume, run and delete), as src/ui/schedules-api.ts
// answers them (design 08-schedules, 09-dashboard-schedules).

import { t } from "../i18n/index.js";
import { postJson, useApi } from "./client.js";
import { API, type ScheduleVerb } from "./routes.js";

export const CADENCE_KINDS = ["interval", "daily", "weekly", "cron"] as const;
export type CadenceKind = (typeof CADENCE_KINDS)[number];
/** The kinds the New and Edit form offer: `schedule add` and `edit` write only these (design 08-schedules). */
export const ACTION_KINDS = ["build", "agent", "feedback", "check_page"] as const;
/** Every stored kind: setup adds an `improve` schedule (the daily improve run) and `summary` ones (the owner's summary), which no form can pick. */
export type ActionKind = (typeof ACTION_KINDS)[number] | "improve" | "summary";
/** Whether the form can write a kind; the Edit form shows any other as a disabled choice and never sends it. */
export const isWritableKind = (k: ActionKind): k is (typeof ACTION_KINDS)[number] => (ACTION_KINDS as readonly string[]).includes(k);

/** One stored schedule. `next_due_at` null: paused, except a Check a page one, which has a `paused` flag and, on each merge, no next run. */
export interface ScheduleRow {
  id: string;
  title: string;
  /** Null for a Check a page schedule that runs on each merge. */
  cadence: { kind: CadenceKind; spec: string } | null;
  zone: string;
  next_due_at: string | null;
  running_since: string | null;
  skip_when_busy: boolean;
  /** What a due occurrence does: `settings.body` for build, `settings.prompt` for agent and feedback, `settings.instruction` and `settings.url` for check_page; improve has none. */
  action: { kind: ActionKind; settings: Record<string, unknown> } | null;
  token_cap: number | null;
  /** `merge` for a Check a page schedule that runs on each merge, else null. */
  trigger: "merge" | null;
  /** A Check a page schedule's pause flag; a plain schedule is paused by a null `next_due_at`. */
  paused: boolean;
  run_cap_usd: number | null;
  daily_cap_usd: number | null;
}

/** One suggestion a Check a page schedule's runs found. */
export interface ScheduleSuggestionRow {
  id: string;
  text: string;
  state: "pending" | "accepted" | "dismissed" | "snoozed";
  created_at: string;
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
  /** check-page: what to look for, the page, and the USD caps of one run and of a day (null clears one). */
  instruction?: string;
  url?: string;
  run_cap_usd?: number | null;
  daily_cap_usd?: number | null;
  /** Add only: first due now, not at the cadence's next slot. */
  run_now?: boolean;
}

/** Every schedule, polled like the other reads. */
export const useSchedules = () => useApi<{ schedules: ScheduleRow[] }>(API.schedules);

/** One schedule's runs, oldest first, polled. */
export const useScheduleRuns = (id: string) => useApi<{ runs: ScheduleRunRow[] }>(API.scheduleRuns(id));

/** One schedule's suggestions, oldest first, polled. */
export const useScheduleSuggestions = (id: string) => useApi<{ suggestions: ScheduleSuggestionRow[] }>(API.scheduleSuggestions(id));

/** Whether a schedule is a Check a page one. */
export const isCheckPage = (s: Pick<ScheduleRow, "action">): boolean => s.action?.kind === "check_page";

/** The text of a schedule's action: a build's body, an agent's or feedback's prompt, a Check a page one's instruction. */
export const actionText = (s: Pick<ScheduleRow, "action">): string => String(s.action?.settings.body ?? s.action?.settings.prompt ?? s.action?.settings.instruction ?? "");

/** A Check a page schedule's page URL; empty for any other. */
export const pageUrl = (s: Pick<ScheduleRow, "action">): string => String(s.action?.settings.url ?? "");

/** Whether a schedule is paused: a Check a page one by its flag, any other by having no next run. */
export const isPaused = (s: ScheduleRow): boolean => (isCheckPage(s) ? s.paused : s.next_due_at === null);

/** POST one schedule write; a refusal (not the owner, the core's reason) comes back as `{ ok: false, error }`. */
export async function postSchedule(token: string, verb: ScheduleVerb, id: string, fields: ScheduleFields = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.scheduleWrite(verb), token, { id, ...fields });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** A drafted schedule: the fields `schedule add` takes. Its `id` is not used: the form makes the ID from the title. */
export interface ScheduleProposal {
  id: string;
  fields: Required<Pick<ScheduleFields, "title" | "cadence" | "spec" | "zone" | "action" | "body">>;
}

/** A stored schedule's text and the revised one. */
export interface ScheduleImprovement {
  id: string;
  old: string;
  new: string;
}

// The draft and improve paths are literals here: POST /api/v1/schedules/draft ({ words }) and /improve ({ id }).
async function postProposal<T>(path: string, token: string, body: Record<string, string>): Promise<{ ok: true; proposal: T } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string; proposal?: T }>(path, token, body);
  return r.ok && r.value.proposal !== undefined ? { ok: true, proposal: r.value.proposal } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** Draft a schedule from the owner's words; stores nothing. */
export const postScheduleDraft = (token: string, words: string) => postProposal<ScheduleProposal>("/api/v1/schedules/draft", token, { words });

/** Revise a stored schedule's text; stores nothing. */
export const postScheduleImprove = (token: string, id: string) => postProposal<ScheduleImprovement>("/api/v1/schedules/improve", token, { id });
