// The google-calendar CalendarSource (docs/plugins/calendar-source.md): reads events, read-only, from the owner's
// primary calendar or the calendars `calendar_ids` lists, for today through 14 days ahead in the process's time zone.
// It asks only for the calendar.readonly scope. Its access token, sync tokens, ETags and last events are in-process
// caches: losing them costs one full read. Every HTTP call goes through the injected client, so no test calls Google.

import type { CalendarFeed, FeedEvent } from "../../index.js";

/** The one scope the plugin asks for, and the only one a token answer may carry. */
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const EVENTS_API = "https://www.googleapis.com/calendar/v3/calendars";
/** The calendar read when `calendar_ids` lists none. */
export const PRIMARY = "primary";
/** Days after today the window covers. */
const DAYS_AHEAD = 14;
/** An access token is refreshed this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** One HTTP request; the real client is fetch. */
export interface HttpRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResponse>;

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
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** What one calendar's last answer left: the window it was read for, its sync token, ETag and events. */
interface CalendarCache {
  timeMin: string;
  timeMax: string;
  syncToken: string | null;
  etag: string | null;
  events: Map<string, FeedEvent>;
}

const fail = (what: string): Error => new Error(`google-calendar: ${what}`);

export class GoogleCalendarSource<N extends string> implements CalendarFeed {
  private access: { token: string; expiresAt: number } | null = null;
  private readonly caches = new Map<string, CalendarCache>();

  constructor(private readonly o: GoogleCalendarOptions<N>) {}

  /** The calendars read: the configured ones, else the primary calendar. */
  get calendars(): readonly string[] {
    return this.o.calendarIds.length > 0 ? this.o.calendarIds : [PRIMARY];
  }

  async events(window: { from: string; to: string }): Promise<readonly FeedEvent[]> {
    const { timeMin, timeMax } = this.window();
    // The sync's window is wider; the source narrows it to its own.
    const from = Math.max(Date.parse(window.from), Date.parse(timeMin));
    const to = Math.min(Date.parse(window.to), Date.parse(timeMax));
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

  /** The start of today through the end of the day DAYS_AHEAD ahead, in the process's time zone. */
  private window(): { timeMin: string; timeMax: string } {
    const now = this.o.now();
    const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).toISOString();
    return { timeMin: day(0), timeMax: day(DAYS_AHEAD + 1) };
  }

  /** One calendar's events: incremental with its sync token, conditional on its ETag; a 410 runs a full read. */
  private async read(id: string, timeMin: string, timeMax: string): Promise<Iterable<FeedEvent>> {
    let cache = this.caches.get(id);
    // A new day moves the window: the old sync token and ETag describe the old one.
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
      const body = await json<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(res, "events read");
      for (const item of body.items ?? []) {
        if (item.status === "cancelled") next.delete(item.id);
        else next.set(item.id, toFeedEvent(item));
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

  /** The cached access token, refreshed from the refresh token when missing or about to expire. */
  private async accessToken(): Promise<string> {
    const now = this.o.now().getTime();
    if (this.access && this.access.expiresAt > now) return this.access.token;
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
      scope: CALENDAR_READONLY_SCOPE,
    }).toString();
    const res = await this.call(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, "token refresh");
    if (res.status !== 200) throw fail(`token refresh failed (HTTP ${res.status})`);
    const answer = await json<{ access_token?: unknown; expires_in?: unknown; scope?: unknown }>(res, "token refresh");
    if (answer.scope !== CALENDAR_READONLY_SCOPE) throw fail("token refresh answered a scope other than calendar.readonly");
    if (typeof answer.access_token !== "string" || answer.access_token === "" || typeof answer.expires_in !== "number") {
      throw fail("token refresh answered no access token");
    }
    this.access = { token: answer.access_token, expiresAt: now + answer.expires_in * 1000 - EXPIRY_MARGIN_MS };
    return this.access.token;
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

class SyncTokenGone extends Error {
  constructor(what: string) {
    super(`google-calendar: ${what}`);
  }
}

/** A body as JSON; a body that is not JSON throws without quoting it. */
async function json<T>(res: HttpResponse, what: string): Promise<T> {
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw fail(`${what} answered a body that is not JSON`);
  }
}

/** An all-day event's date is a local day: its instant is that day's local midnight. */
function instant(t: { date?: string; dateTime?: string } | undefined): string {
  if (t?.dateTime) return new Date(t.dateTime).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t?.date ?? "");
  if (!m) throw fail("an event has no start or end time");
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

function toFeedEvent(e: GoogleEvent): FeedEvent {
  return {
    id: e.id,
    title: e.summary ?? "",
    starts_at: instant(e.start),
    ends_at: instant(e.end),
    all_day: e.start?.date !== undefined && e.start.dateTime === undefined,
    updated_at: e.updated ? new Date(e.updated).toISOString() : null,
  };
}
