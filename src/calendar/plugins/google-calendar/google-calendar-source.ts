// The google-calendar CalendarSource (docs/plugins/calendar-source.md): reads events from the owner's primary calendar
// or the calendars `calendar_ids` lists: every event that overlaps the window the sync passes. It reads Google for the
// whole local days that window touches, so the read's bounds hold for a local day and one sync per day after the
// first reads incrementally.
// Its sync port (`sync`, design 02-tasks-calendar, copy to a connected calendar) copies the owner's local events into
// the first calendar it reads: one events call per add, edit or delete, a repeating event as one recurring event, so
// an edit or a delete acts on the whole series. It writes only when the token answer grants calendar.events: a
// connection with calendar.readonly alone is read-only and makes no write call. A token answer with any other scope
// is refused. Its access token, sync tokens, ETags and last events are in-process caches: losing them costs one full
// read. Every HTTP call goes through the injected client, so no test calls Google.

import type { CalendarFeed, CopyFields, EventDetails, EventPerson, FeedEvent, SyncPort } from "../../index.js";

/** The read scope of a read-only connection. */
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
/** The scope a connection with write access asks for: it reads and writes events. */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_SCOPES: ReadonlySet<string> = new Set([CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE]);

/** The scopes of a token answer's space-separated `scope`, or null when it names none or any other scope. */
export function calendarScopes(scope: unknown): ReadonlySet<string> | null {
  if (typeof scope !== "string") return null;
  const granted = new Set(scope.split(" ").filter((s) => s !== ""));
  return granted.size > 0 && [...granted].every((s) => CALENDAR_SCOPES.has(s)) ? granted : null;
}
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const EVENTS_API = "https://www.googleapis.com/calendar/v3/calendars";
/** The calendar read when `calendar_ids` lists none. */
export const PRIMARY = "primary";
/**
 * The OAuth error code a token refresh answers when the refresh token is expired or revoked (a client in Testing status
 * loses it after 7 days). It is thrown, and so stored, as the whole error: the dashboard shows its reconnect state for it.
 */
export const INVALID_GRANT = "invalid_grant";
/** An access token is refreshed this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** One HTTP request; the real client is fetch. */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** How long one HTTP call to Google may take, its body included, before it fails as "no answer". */
export const GOOGLE_HTTP_TIMEOUT_MS = 30_000;

/** fetch, given up after `ms`: a hung Google fails that sync instead of holding up the controller's tick. */
export const timedFetch = (ms: number): HttpClient => (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

/** The SecretStore as this source uses it: one `get` per name. */
export interface SecretReader<N extends string> {
  get(name: N): Promise<{ reveal(): string } | null>;
}

export interface GoogleCalendarOptions<N extends string> {
  http: HttpClient;
  now: () => Date;
  secrets: SecretReader<N>;
  /** The secret names the descriptor declares. */
  names: { refreshToken: N; clientId: N; clientSecret: N };
  /** Checked by calendarIds(); [] reads the primary calendar. */
  calendarIds: readonly string[];
}

/** The `calendar_ids` config value: absent, or a list of non-empty strings. Anything else fails startup. */
export function calendarIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new Error("calendar_ids must be a list of non-empty calendar ID strings (docs/plugins/calendar-source.md)");
  }
  return [...new Set(raw as string[])];
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  updated?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string };
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  organizer?: GooglePerson;
  attendees?: (GooglePerson & { responseStatus?: string; resource?: boolean })[];
}

interface GooglePerson {
  email?: string;
  displayName?: string;
}

/** The calendar a page of events belongs to, as the events read answers it alongside them. */
interface GoogleCalendarMeta {
  summary?: string;
  timeZone?: string;
}

/** What one calendar's last answer left: the window it was read for, its sync token, ETag and events. */
interface CalendarCache {
  timeMin: string;
  timeMax: string;
  syncToken: string | null;
  etag: string | null;
  events: Map<string, FeedEvent>;
}

export const fail = (what: string): Error => new Error(`google-calendar: ${what}`);

export class GoogleCalendarSource<N extends string> implements CalendarFeed {
  private access: { token: string; expiresAt: number; write: boolean } | null = null;
  private readonly caches = new Map<string, CalendarCache>();
  /** The sync port: copies of the owner's local events in the first calendar read. */
  readonly sync: SyncPort = {
    writable: async () => (await this.grant()).write,
    add: async (copy) => this.addCopy(copy),
    edit: async (id, copy) => void (await this.write("PUT", "event edit", id, copy)),
    remove: async (id) => void (await this.write("DELETE", "event delete", id)),
  };

  constructor(private readonly o: GoogleCalendarOptions<N>) {}

  /** The calendars read: the configured ones, else the primary calendar. */
  get calendars(): readonly string[] {
    return this.o.calendarIds.length > 0 ? this.o.calendarIds : [PRIMARY];
  }

  async events(window: { from: string; to: string }): Promise<readonly FeedEvent[]> {
    const { timeMin, timeMax } = readWindow(window);
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    const out: FeedEvent[] = [];
    for (const id of this.calendars) {
      for (const e of await this.read(id, timeMin, timeMax)) {
        if (Date.parse(e.starts_at) >= to || Date.parse(e.ends_at) <= from) continue;
        // Event IDs are unique per calendar; with several, the calendar ID keeps them unique within the source.
        out.push(this.calendars.length > 1 ? { ...e, id: `${id}/${e.id}` } : e);
      }
    }
    return out;
  }

  /** One calendar's events: incremental with its sync token, conditional on its ETag; a 410 runs a full read. */
  private async read(id: string, timeMin: string, timeMax: string): Promise<Iterable<FeedEvent>> {
    let cache = this.caches.get(id);
    // A new day moves the read's window: the old sync token and ETag describe the old one.
    if (!cache || cache.timeMin !== timeMin || cache.timeMax !== timeMax) {
      cache = { timeMin, timeMax, syncToken: null, etag: null, events: new Map() };
      this.caches.set(id, cache);
    }
    try {
      await this.fetchInto(id, cache);
    } catch (e) {
      if (!(e instanceof SyncTokenGone)) throw e;
      cache.syncToken = null;
      cache.etag = null;
      cache.events = new Map();
      await this.fetchInto(id, cache);
    }
    return cache.events.values();
  }

  private async fetchInto(id: string, cache: CalendarCache): Promise<void> {
    const full = cache.syncToken === null;
    const next = full ? new Map<string, FeedEvent>() : new Map(cache.events);
    let pageToken: string | null = null;
    let etag: string | null = null;
    let first = true;
    for (;;) {
      const params = new URLSearchParams({ singleEvents: "true", maxResults: "2500" });
      if (full) {
        params.set("timeMin", cache.timeMin);
        params.set("timeMax", cache.timeMax);
      } else params.set("syncToken", cache.syncToken!);
      if (pageToken) params.set("pageToken", pageToken);
      const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, accept: "application/json" };
      if (first && cache.etag) headers["if-none-match"] = cache.etag;
      const res = await this.call(`${EVENTS_API}/${encodeURIComponent(id)}/events?${params}`, { method: "GET", headers }, "events read");
      if (first && res.status === 304) return;
      if (res.status === 410) throw new SyncTokenGone(`events read of calendar ${id} refused its sync token (HTTP 410)`);
      if (res.status === 401) this.access = null;
      if (res.status !== 200) throw fail(`events read of calendar ${id} failed (HTTP ${res.status})`);
      if (first) etag = res.headers.get("etag");
      first = false;
      const body = await json<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string } & GoogleCalendarMeta>(res, "events read");
      for (const item of body.items ?? []) {
        if (item.status === "cancelled") next.delete(item.id);
        else next.set(item.id, toFeedEvent(item, body));
      }
      if (body.nextPageToken) {
        pageToken = body.nextPageToken;
        continue;
      }
      // Kept only once every page is read, so a 304 never stands for a half-read answer.
      cache.etag = etag;
      cache.syncToken = body.nextSyncToken ?? null;
      cache.events = next;
      return;
    }
  }

  /** One add: the new event's ID as this source's read reports it (prefixed by its calendar when it reads several). */
  private async addCopy(copy: CopyFields): Promise<string> {
    const created = await this.write("POST", "event add", null, copy);
    if (typeof created?.id !== "string" || created.id === "") throw fail("event add answered no event ID");
    return this.calendars.length > 1 ? `${this.calendars[0]}/${created.id}` : created.id;
  }

  /**
   * One events call on a copy: POST adds (no `id`), PUT replaces it whole (its series when it repeats), DELETE removes
   * it (an event already gone counts as removed). Refused before any call when the connection is read-only.
   */
  private async write(method: "POST" | "PUT" | "DELETE", what: string, id: string | null, copy?: CopyFields): Promise<{ id?: unknown } | null> {
    const { token, write } = await this.grant();
    if (!write) throw fail(`${what} refused: the connection is read-only (calendar.readonly); reconnect with write access`);
    const at = id === null ? { calendar: this.calendars[0]!, event: null } : copyAddress(id, this.calendars[0]!);
    const url = `${EVENTS_API}/${encodeURIComponent(at.calendar)}/events${at.event === null ? "" : `/${encodeURIComponent(at.event)}`}`;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (copy) headers["content-type"] = "application/json";
    const res = await this.call(url, { method, headers, ...(copy ? { body: JSON.stringify(eventBody(copy)) } : {}) }, what);
    if (res.status === 401) this.access = null;
    if (method === "DELETE" && (res.status === 404 || res.status === 410)) return null;
    if (res.status !== 200 && res.status !== 204) throw fail(`${what} failed (HTTP ${res.status})`);
    return method === "DELETE" ? null : json<{ id?: unknown }>(res, what);
  }

  /** The cached access token, refreshed from the refresh token when missing or about to expire. */
  private async accessToken(): Promise<string> {
    return (await this.grant()).token;
  }

  /** The cached access token and whether it may write, refreshed when missing or about to expire. */
  private async grant(): Promise<{ token: string; write: boolean }> {
    const now = this.o.now().getTime();
    if (this.access && this.access.expiresAt > now) return this.access;
    const [refresh, clientId, clientSecret] = await Promise.all([
      this.secret(this.o.names.refreshToken),
      this.secret(this.o.names.clientId),
      this.secret(this.o.names.clientSecret),
    ]);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const res = await this.call(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, "token refresh");
    if (res.status === 400 && (await errorCode(res)) === INVALID_GRANT) throw new Error(INVALID_GRANT);
    if (res.status !== 200) throw fail(`token refresh failed (HTTP ${res.status})`);
    const answer = await json<{ access_token?: unknown; expires_in?: unknown; scope?: unknown }>(res, "token refresh");
    const scopes = calendarScopes(answer.scope);
    if (scopes === null) throw fail("token refresh answered a scope other than calendar.readonly or calendar.events");
    if (typeof answer.access_token !== "string" || answer.access_token === "" || typeof answer.expires_in !== "number") {
      throw fail("token refresh answered no access token");
    }
    this.access = { token: answer.access_token, expiresAt: now + answer.expires_in * 1000 - EXPIRY_MARGIN_MS, write: scopes.has(CALENDAR_EVENTS_SCOPE) };
    return this.access;
  }

  private async secret(name: N): Promise<string> {
    const value = (await this.o.secrets.get(name))?.reveal();
    if (!value) throw fail(`${name} is not set in the SecretStore`);
    return value;
  }

  /** One HTTP call; a network failure throws without its cause, which may quote the request. */
  private async call(url: string, init: HttpRequest, what: string): Promise<HttpResponse> {
    try {
      return await this.o.http(url, init);
    } catch {
      throw fail(`${what} failed (no answer)`);
    }
  }
}

/**
 * What Google is asked for: from the local midnight of the day `window.from` falls on to the local midnight after the
 * day `window.to` falls on, in the process's time zone. The sync's window (a day back to 30 days ahead) moves every
 * sync; these bounds move only at local midnight (yesterday's midnight to 31 days ahead), so the sync token stays valid all day.
 */
function readWindow(window: { from: string; to: string }): { timeMin: string; timeMax: string } {
  const midnight = (iso: string, days: number) => {
    const t = new Date(iso);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() + days).toISOString();
  };
  return { timeMin: midnight(window.from, 0), timeMax: midnight(window.to, 1) };
}

/** A copy's calendar and event ID: `calendar/event` when the source reads several calendars, else the event in `first`. */
function copyAddress(id: string, first: string): { calendar: string; event: string } {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? { calendar: first, event: id } : { calendar: id.slice(0, slash), event: id.slice(slash + 1) };
}

const RRULE: Readonly<Record<CopyFields["repeats"], string | null>> = { none: null, daily: "RRULE:FREQ=DAILY", weekly: "RRULE:FREQ=WEEKLY", monthly: "RRULE:FREQ=MONTHLY" };

/** The day (YYYY-MM-DD) the clock in `zone` reads at the instant `iso`. */
function dayIn(iso: string, zone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The event resource for a copy: its title and times (an all-day one as the local days it spans, the end day not
 * included), the zone, and a repeat as one recurrence rule with no end, stepping from the first start as the local
 * read does (a monthly one on the 29th to 31st skips the months without that day).
 */
function eventBody(c: CopyFields): Record<string, unknown> {
  const at = (iso: string) => (c.all_day ? { date: dayIn(iso, c.time_zone) } : { dateTime: iso, timeZone: c.time_zone });
  const rule = RRULE[c.repeats];
  return { summary: c.title, start: at(c.starts_at), end: at(c.ends_at), ...(rule === null ? {} : { recurrence: [rule] }) };
}

class SyncTokenGone extends Error {
  constructor(what: string) {
    super(`google-calendar: ${what}`);
  }
}

/** A body as JSON; a body that is not JSON throws without quoting it. */
export async function json<T>(res: HttpResponse, what: string): Promise<T> {
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw fail(`${what} answered a body that is not JSON`);
  }
}

/** The `error` code of an OAuth error body, read alone: the rest of the body is never kept. Null when there is none. */
async function errorCode(res: HttpResponse): Promise<string | null> {
  const body = await json<{ error?: unknown }>(res, "token refresh").catch(() => null);
  return typeof body?.error === "string" ? body.error : null;
}

/** An all-day event's date is a local day: its instant is that day's local midnight. */
function instant(t: { date?: string; dateTime?: string } | undefined): string {
  if (t?.dateTime) return new Date(t.dateTime).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t?.date ?? "");
  if (!m) throw fail("an event has no start or end time");
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

function toFeedEvent(e: GoogleEvent, calendar: GoogleCalendarMeta): FeedEvent {
  return {
    id: e.id,
    title: e.summary ?? "",
    starts_at: instant(e.start),
    ends_at: instant(e.end),
    all_day: e.start?.date !== undefined && e.start.dateTime === undefined,
    updated_at: e.updated ? new Date(e.updated).toISOString() : null,
    details: details(e, calendar),
  };
}

/** Notes are cut to this many characters. */
const DESCRIPTION_MAX = 8000;
/** At most this many attendees are kept per event. */
const ATTENDEES_MAX = 100;
/** `value` when it is an http(s) URL, else null: a link the dashboard opens never runs script (`javascript:`). */
const httpUrl = (value: unknown): string | null => (typeof value === "string" && /^https?:\/\/\S+$/i.test(value) ? value : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const RESPONSES: Readonly<Record<string, EventPerson["response"]>> = { accepted: "accepted", declined: "declined", tentative: "tentative", needsAction: "waiting" };
const person = (p: GooglePerson & { responseStatus?: string }): EventPerson => ({
  name: text(p.displayName), email: text(p.email), response: RESPONSES[p.responseStatus ?? ""] ?? null,
});

/**
 * What the event read already answers beyond the title and times (no other call, no other scope): the calendar's name,
 * place, notes (cut to DESCRIPTION_MAX), organizer, attendees (rooms left out, at most ATTENDEES_MAX), the video link
 * and the event's page; links only when http(s).
 */
function details(e: GoogleEvent, calendar: GoogleCalendarMeta): EventDetails {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const description = text(e.description);
  return {
    calendar: text(calendar.summary),
    location: text(e.location),
    description: description === null ? null : description.slice(0, DESCRIPTION_MAX),
    organizer: e.organizer && (text(e.organizer.email) ?? text(e.organizer.displayName)) !== null ? person(e.organizer) : null,
    attendees: (e.attendees ?? []).filter((a) => a.resource !== true).slice(0, ATTENDEES_MAX).map(person),
    conference_url: httpUrl(video) ?? httpUrl(e.hangoutLink),
    link: httpUrl(e.htmlLink),
    time_zone: text(e.start?.timeZone) ?? text(calendar.timeZone),
  };
}
