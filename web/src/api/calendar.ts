// The Calendar page and the Settings page's Calendar section: GET /api/v1/calendar/events (useCalendarEvents),
// POST /api/v1/calendar/sync (postCalendarSync), GET /api/v1/calendar, POST /api/v1/calendar/connect and POST
// /api/v1/calendar/disconnect.

import { t } from "../i18n/index.js";
import { postJson, useApi } from "./client.js";
import { API } from "./routes.js";
import type { CalendarSync, EventRow } from "./tasks.js";

/** A person on an event, as its calendar names them; `response` their answer to the invitation, when it says. */
export interface EventPerson {
  name: string | null;
  email: string | null;
  response: "accepted" | "declined" | "tentative" | "waiting" | null;
}

/** What an event says beyond its title and times (src/calendar/event-details.ts); every text passed the egress scan. */
export interface EventDetails {
  calendar: string | null;
  location: string | null;
  /** The notes as the calendar wrote them, possibly with markup: shown as text, never as HTML. */
  description: string | null;
  organizer: EventPerson | null;
  attendees: EventPerson[];
  conference_url: string | null;
  link: string | null;
  time_zone: string | null;
}

/** One event of a Calendar page day: the row the Tasks views list too, with its instants and its details. */
export interface CalendarEvent extends Omit<EventRow, "kind"> {
  /** `agent`: a schedule's run or next slot (source `agent`), read-only; `event`: every other entry (a human event). */
  kind: "event" | "agent";
  /** Only on an agent entry: the schedule's next slot, not a run. */
  next?: boolean;
  starts_at: string;
  ends_at: string;
  /** Null for an event stored before details were kept, or one its calendar said nothing more about. */
  details: EventDetails | null;
  /** Only on an owner's local event (source `local`): its repeat; a repeating one is read as each occurrence. */
  repeats?: LocalRepeat;
  /** Only on a local event: the connected calendar that holds its copy, or null. */
  copied_to?: string | null;
  /** Only on a local event: its copy's last write error, kept on the event and never retried; null after a success. */
  sync_error?: string | null;
}

/** The connected calendar a new local event can be copied to, and whether its sign-in takes writes. */
export interface CopyTarget {
  label: string;
  writable: boolean;
}

/** One day of `/api/v1/calendar/events`: its events (all-day first, then timed by time) and whether every source's last sync covered it. */
export interface CalendarDay {
  date: string;
  synced: boolean;
  events: CalendarEvent[];
}

/** `/api/v1/calendar/events?from=&to=`: each day from `from` through `to`, and each source's last sync. */
export interface CalendarEvents {
  from: string;
  to: string;
  /** The factory process's time zone (an IANA name): the zone a new local event is entered in by default. */
  time_zone?: string;
  days: CalendarDay[];
  calendar: CalendarSync[];
  /** A sync request for exactly `from` through `to` waits for the controller. */
  sync_pending: boolean;
  /** The calendar a new event's switch copies to, and its stored write access; null (or absent) when no connected calendar takes copies. */
  copy?: CopyTarget | null;
}

/** The stored calendar events of the days `from` through `to`, polled like the other reads; never a calendar source call. */
export function useCalendarEvents(from: string, to: string) {
  return useApi<CalendarEvents>(API.calendarEvents(from, to));
}

/**
 * POST /api/v1/calendar/sync: asks the factory to sync every calendar for the local days `from` through `to` now; the
 * controller runs it on its next poll. A refusal (not the owner, a bad range) comes back as `{ ok: false, error }`.
 */
export async function postCalendarSync(token: string, from: string, to: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.calendarSync, token, { from, to });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** The source name the read gives the owner's own events: the only ones the page edits or deletes. */
export const LOCAL_SOURCE = "local";
export const LOCAL_REPEATS = ["none", "daily", "weekly", "monthly"] as const;
export type LocalRepeat = (typeof LOCAL_REPEATS)[number];

/** The fields a local event is added with; times are ISO instants. */
export interface LocalEventInput {
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  repeats: LocalRepeat;
}

const LOCAL_EVENTS = "/api/v1/calendar/local-events";

/** What a local write's copy did: not asked, no calendar takes it (`reason`), done, or failed (`error`, kept on the event). */
export type CopyResult =
  | { state: "off" }
  | { state: "unavailable"; reason: string }
  | { state: "synced"; provider: string }
  | { state: "failed"; error: string };
type Answer = { ok: true; sync: CopyResult } | { ok: false; error: string };

async function postLocal(path: string, token: string, body: unknown): Promise<Answer> {
  const r = await postJson<{ error?: string; sync?: CopyResult }>(path, token, body);
  return r.ok ? { ok: true, sync: r.value.sync ?? { state: "off" } } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** POST /api/v1/calendar/local-events: adds the event under the caller-made `le_` id, so a retry stores one; `sync` copies it too. */
export const postLocalEventAdd = (token: string, id: string, fields: LocalEventInput, sync = false) => postLocal(LOCAL_EVENTS, token, { id, ...fields, ...(sync ? { sync } : {}) });

/** POST /api/v1/calendar/local-events/edit: changes the fields named; a repeating event changes as a whole series. */
export const postLocalEventEdit = (token: string, id: string, fields: Partial<LocalEventInput>) => postLocal(`${LOCAL_EVENTS}/edit`, token, { id, ...fields });

/** POST /api/v1/calendar/local-events/delete: removes the event and all its repeats. */
export const postLocalEventDelete = (token: string, id: string) => postLocal(`${LOCAL_EVENTS}/delete`, token, { id });

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
  /** Connected with a sync port: whether it takes writes (stored, never asked of the provider). Null or absent: no sync port, or not connected. */
  write_access?: boolean | null;
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
 * client" option) and the values the last answer asked for (none on that option's first try). `write`: with write
 * access, so the owner's local events can be copied there.
 */
export async function postCalendarConnect(token: string, plugin: string, own?: { values?: Record<string, string> }, write = false): Promise<CalendarConnectResult> {
  const plain = own === undefined ? { plugin } : { plugin, own_client: true, ...(own.values === undefined ? {} : { values: own.values }) };
  const body = write ? { ...plain, write } : plain;
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
