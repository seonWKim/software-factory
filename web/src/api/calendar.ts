// The Calendar page and the Settings page's Calendar section: GET /api/v1/calendar/events (useCalendarEvents),
// GET /api/v1/calendar, POST /api/v1/calendar/connect and POST /api/v1/calendar/disconnect.

import { t } from "../i18n/index.js";
import { postJson, useApi } from "./client.js";
import { API } from "./routes.js";
import type { CalendarSync, EventRow } from "./tasks.js";

/** One day of `/api/v1/calendar/events`: its events (all-day first, then timed by time) and whether every source's last sync covered it. */
export interface CalendarDay {
  date: string;
  synced: boolean;
  events: EventRow[];
}

/** `/api/v1/calendar/events?from=&to=`: each day from `from` through `to`, and each source's last sync. */
export interface CalendarEvents {
  from: string;
  to: string;
  days: CalendarDay[];
  calendar: CalendarSync[];
}

/** The stored calendar events of the days `from` through `to`, polled like the other reads; never a calendar source call. */
export function useCalendarEvents(from: string, to: string) {
  return useApi<CalendarEvents>(API.calendarEvents(from, to));
}

/** One calendar plugin on the Settings page's Calendar section (GET /api/v1/calendar, design 08-settings). */
export interface CalendarPluginView {
  /** The plugin's own name, its only label. */
  name: string;
  /** Listed in the live `calendar` setting (else the config file's key). */
  connected: boolean;
  /** This build carries the default sign-in a plain Connect takes; false: only the own-client option can connect. */
  default_client: boolean;
  synced_at: string | null;
  /** The last sync's error; null after a success. RECONNECT_ERROR when the sign-in expired. */
  error: string | null;
  /** The sign-in this server process started, if any. */
  attempt: { state: "signing_in" | "connected" | "failed"; events: number | null; error: string | null } | null;
}

/**
 * The stored sync error that means the sign-in expired or was revoked (the OAuth code a source stores alone, e.g. a
 * client in Testing status after 7 days): the section asks to connect again instead of showing it raw.
 */
export const RECONNECT_ERROR = "invalid_grant";

export interface CalendarView {
  plugins: CalendarPluginView[];
}

/** What POST /api/v1/calendar/connect answered: the inputs to ask for, the consent page to open, or a refusal. */
export type CalendarConnectResult =
  | { ok: true; state: "needs_input"; needs: string[] }
  | { ok: true; state: "signing_in"; consent_url: string }
  | { ok: true; state: "connected" | "failed"; events: number | null }
  | { ok: false; error: string };

/**
 * POST /api/v1/calendar/connect: the plugin alone (the default sign-in), or with `own` (the advanced "use my own
 * client" option) and the values the last answer asked for (none on that option's first try).
 */
export async function postCalendarConnect(token: string, plugin: string, own?: { values?: Record<string, string> }): Promise<CalendarConnectResult> {
  const body = own === undefined ? { plugin } : { plugin, own_client: true, ...(own.values === undefined ? {} : { values: own.values }) };
  const r = await postJson<{ state?: string; needs?: string[]; consent_url?: string; events?: number | null; error?: string }>(API.calendarConnect, token, body);
  if (!r.ok) return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
  const v = r.value;
  if (v.state === "needs_input") return { ok: true, state: "needs_input", needs: v.needs ?? [] };
  if (v.state === "signing_in") return { ok: true, state: "signing_in", consent_url: v.consent_url ?? "" };
  return { ok: true, state: v.state === "failed" ? "failed" : "connected", events: v.events ?? null };
}

/** POST /api/v1/calendar/disconnect. A refusal comes back as `{ ok: false, error }`. */
export async function postCalendarDisconnect(token: string, plugin: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.calendarDisconnect, token, { plugin });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
