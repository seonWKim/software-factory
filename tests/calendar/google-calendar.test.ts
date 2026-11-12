import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SYNC_MS, syncCalendars } from "../../src/calendar/index.js";
import descriptor from "../../src/calendar/plugins/google-calendar/google-calendar.plugin.js";
import {
  CALENDAR_READONLY_SCOPE,
  EVENTS_API,
  GoogleCalendarSource,
  type HttpClient,
  type HttpRequest,
  TOKEN_URL,
  calendarIds,
} from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";
import { build, loadConfig } from "../../src/compose.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import type { Secret, SecretName, SecretStore } from "../../src/interfaces/secret-store.js";
import { REGISTRY } from "../../src/plugins.js";
import type { SqlDriver } from "../../src/state/index.js";
import { fakeRepoLookup } from "../helpers/fakes.js";
import { newStore } from "../helpers/store.js";

// The google-calendar CalendarSource (docs/plugins/calendar-source.md). No test calls Google: every request goes to
// the fake HTTP client below, secrets come from a fake SecretStore that records each get, and time from FakeClock.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_FILE = join(REPO_ROOT, "src", "calendar", "plugins", "google-calendar", "google-calendar-source.ts");
const SECRETS = { GOOGLE_REFRESH_TOKEN: "refresh-secret-value", GOOGLE_CLIENT_ID: "client-id-value", GOOGLE_CLIENT_SECRET: "client-secret-value" };
const NAMES = { refreshToken: "GOOGLE_REFRESH_TOKEN", clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

class RecordingSecrets implements SecretStore {
  readonly gets: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    this.gets.push(name);
    const value = this.values[name];
    if (value === undefined) return null;
    return { name, reveal: () => value, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

interface Answer {
  status: number;
  body?: unknown;
  etag?: string;
}

/** A fake HTTP client: records each request; token requests and event reads are answered by the two handlers. */
class FakeHttp {
  readonly requests: { url: URL; init: HttpRequest }[] = [];
  token: (body: URLSearchParams) => Answer = () => ({ status: 200, body: { access_token: "access-1", expires_in: 3600, scope: CALENDAR_READONLY_SCOPE } });
  events: (calendar: string, params: URLSearchParams, headers: Record<string, string>) => Answer = () => ({ status: 200, body: { items: [], nextSyncToken: "s1" } });

  readonly client: HttpClient = async (url, init) => {
    const u = new URL(url);
    this.requests.push({ url: u, init });
    let a: Answer;
    if (url === TOKEN_URL) a = this.token(new URLSearchParams(init.body));
    else {
      const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname);
      if (!url.startsWith(EVENTS_API) || !m) throw new Error(`unexpected request ${url}`);
      a = this.events(decodeURIComponent(m[1]!), u.searchParams, init.headers);
    }
    return {
      status: a.status,
      headers: { get: (n: string) => (n.toLowerCase() === "etag" ? (a.etag ?? null) : null) },
      text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body ?? {})),
    };
  };

  eventReads() {
    return this.requests.filter((r) => r.url.href.startsWith(EVENTS_API));
  }
  tokenRequests() {
    return this.requests.filter((r) => r.url.href === TOKEN_URL);
  }
}

const NOW = "2026-11-12T12:00:00.000Z";

function setup(ids: readonly string[] = [], secrets: Record<string, string> = SECRETS) {
  const clock = new FakeClock(NOW);
  const http = new FakeHttp();
  const store = new RecordingSecrets(secrets);
  const source = new GoogleCalendarSource({ http: http.client, now: () => clock.now(), secrets: store, names: NAMES, calendarIds: ids });
  return { clock, http, store, source };
}

/** The window the sync asks for: a day back to 30 days ahead. */
function syncWindow(clock: FakeClock) {
  const t = clock.now().getTime();
  return { from: new Date(t - 86_400_000).toISOString(), to: new Date(t + 30 * 86_400_000).toISOString() };
}

function localDay(clock: FakeClock, offset: number): string {
  const n = clock.now();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset).toISOString();
}

const timed = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, summary: `event ${id}`, start: { dateTime: start }, end: { dateTime: end }, updated: "2026-11-01T00:00:00.000Z", ...extra,
});

async function errorOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => "", (e: Error) => e.message);
}

describe("google-calendar: scope", () => {
  it("asks only for calendar.readonly, with the refresh token, client ID and client secret from the SecretStore", async () => {
    const { http, source, clock } = setup();
    await source.events(syncWindow(clock));
    const [token] = http.tokenRequests();
    const body = new URLSearchParams(token!.init.body);
    expect(token!.init.method).toBe("POST");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("scope")).toBe(CALENDAR_READONLY_SCOPE);
    expect(CALENDAR_READONLY_SCOPE.endsWith("/calendar.readonly")).toBe(true);
    expect([body.get("refresh_token"), body.get("client_id"), body.get("client_secret")]).toEqual([
      SECRETS.GOOGLE_REFRESH_TOKEN, SECRETS.GOOGLE_CLIENT_ID, SECRETS.GOOGLE_CLIENT_SECRET,
    ]);
    // Every read is a GET: the source never writes.
    expect(http.eventReads().map((r) => r.init.method)).toEqual(["GET"]);
  });

  it("a token answer whose scope is not exactly calendar.readonly is refused, and no event is read", async () => {
    for (const scope of [`${CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar`, "https://www.googleapis.com/auth/calendar", undefined, ""]) {
      const { http, source, clock } = setup();
      http.token = () => ({ status: 200, body: { access_token: "access-1", expires_in: 3600, scope } });
      expect(await errorOf(source.events(syncWindow(clock)))).toMatch(/scope other than calendar\.readonly/);
      expect(http.eventReads()).toEqual([]);
    }
  });

  it("keeps the access token until it expires", async () => {
    const { http, source, clock } = setup();
    await source.events(syncWindow(clock));
    clock.advance(CALENDAR_SYNC_MS);
    await source.events(syncWindow(clock));
    expect(http.tokenRequests()).toHaveLength(1);
    clock.advance(3600_000);
    await source.events(syncWindow(clock));
    expect(http.tokenRequests()).toHaveLength(2);
  });
});

describe("google-calendar: window and calendars", () => {
  it("reads the start of today through the end of the day 14 days ahead, local time, and drops events outside it", async () => {
    const { http, source, clock } = setup();
    const from = localDay(clock, 0);
    const to = localDay(clock, 15);
    http.events = () => ({
      status: 200,
      body: {
        items: [
          timed("yesterday", localDay(clock, -1), new Date(Date.parse(from) - 1000).toISOString()),
          timed("today", from, new Date(Date.parse(from) + 3600_000).toISOString()),
          timed("last", new Date(Date.parse(to) - 3600_000).toISOString(), to),
          timed("too-late", to, localDay(clock, 16)),
        ],
        nextSyncToken: "s1",
      },
    });
    const events = await source.events(syncWindow(clock));
    const [read] = http.eventReads();
    expect(read!.url.searchParams.get("timeMin")).toBe(from);
    expect(read!.url.searchParams.get("timeMax")).toBe(to);
    expect(read!.url.searchParams.get("singleEvents")).toBe("true");
    expect(events.map((e) => e.id)).toEqual(["today", "last"]);
    expect(events[0]).toEqual({ id: "today", title: "event today", starts_at: from, ends_at: new Date(Date.parse(from) + 3600_000).toISOString(), all_day: false, updated_at: "2026-11-01T00:00:00.000Z" });
  });

  it("an all-day event spans its local days", async () => {
    const { http, source, clock } = setup();
    const n = clock.now();
    const date = (o: number) => {
      const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + o);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    http.events = () => ({ status: 200, body: { items: [{ id: "a", summary: "off", start: { date: date(1) }, end: { date: date(2) } }] } });
    expect(await source.events(syncWindow(clock))).toEqual([{ id: "a", title: "off", starts_at: localDay(clock, 1), ends_at: localDay(clock, 2), all_day: true, updated_at: null }]);
  });

  it("the source file reads no clock: it imports no clock module and calls no Date.now or new Date()", () => {
    const text = readFileSync(SOURCE_FILE, "utf8");
    expect(text).not.toMatch(/interfaces\/clock|impl\/clock/);
    expect(text).not.toMatch(/\bDate\.now\s*\(|\bnew Date\(\s*\)|\bperformance\.now\s*\(/);
  });

  it("with no calendar IDs configured, only the primary calendar is read", async () => {
    const { http, source, clock } = setup();
    await source.events(syncWindow(clock));
    expect(source.calendars).toEqual(["primary"]);
    expect(http.eventReads().map((r) => r.url.pathname)).toEqual(["/calendar/v3/calendars/primary/events"]);
  });

  it("with calendar_ids, those calendars are read instead of the primary one", async () => {
    const { http, source, clock } = setup(["work@example.com", "team#holidays"]);
    http.events = () => ({ status: 200, body: { items: [timed("e1", localDay(clock, 1), localDay(clock, 2))] } });
    const events = await source.events(syncWindow(clock));
    expect(http.eventReads().map((r) => decodeURIComponent(r.url.pathname))).toEqual([
      "/calendar/v3/calendars/work@example.com/events",
      "/calendar/v3/calendars/team#holidays/events",
    ]);
    // Event IDs stay unique within the source.
    expect(events.map((e) => e.id)).toEqual(["work@example.com/e1", "team#holidays/e1"]);
  });

  it("calendar_ids must be a list of non-empty strings", () => {
    expect(calendarIds(undefined)).toEqual([]);
    expect(calendarIds([])).toEqual([]);
    expect(calendarIds(["a", "b", "a"])).toEqual(["a", "b"]);
    for (const bad of ["primary", [""], ["  "], [1], [null], {}, null]) {
      expect(() => calendarIds(bad), JSON.stringify(bad)).toThrow(/calendar_ids must be a list of non-empty calendar ID strings/);
    }
  });
});

describe("google-calendar: sync token and ETag", () => {
  it("sends the stored sync token on the next read and applies its changes", async () => {
    const { http, source, clock } = setup();
    const t = (o: number) => localDay(clock, o);
    http.events = (_c, params) =>
      params.get("syncToken") === null
        ? { status: 200, body: { items: [timed("a", t(1), t(2)), timed("b", t(2), t(3))], nextSyncToken: "s1" } }
        : { status: 200, body: { items: [{ id: "a", status: "cancelled" }, timed("c", t(3), t(4))], nextSyncToken: "s2" } };
    expect((await source.events(syncWindow(clock))).map((e) => e.id)).toEqual(["a", "b"]);
    expect((await source.events(syncWindow(clock))).map((e) => e.id)).toEqual(["b", "c"]);
    await source.events(syncWindow(clock));
    const params = http.eventReads().map((r) => r.url.searchParams);
    expect(params.map((p) => p.get("syncToken"))).toEqual([null, "s1", "s2"]);
    // An incremental read carries no time bounds; Google refuses them beside a sync token.
    expect(params[1]!.get("timeMin")).toBeNull();
  });

  it("a 410 clears the sync token and runs a full read in the same sync", async () => {
    const { http, source, clock } = setup();
    const t = (o: number) => localDay(clock, o);
    let full = 0;
    http.events = (_c, params) => {
      if (params.get("syncToken") === "s1") return { status: 410, body: { error: "gone" } };
      full += 1;
      return { status: 200, body: { items: [timed(full === 1 ? "a" : "b", t(1), t(2))], nextSyncToken: "s1" }, etag: `"e${full}"` };
    };
    expect((await source.events(syncWindow(clock))).map((e) => e.id)).toEqual(["a"]);
    expect((await source.events(syncWindow(clock))).map((e) => e.id)).toEqual(["b"]);
    const reads = http.eventReads();
    expect(reads.map((r) => r.url.searchParams.get("syncToken"))).toEqual([null, "s1", null]);
    // The full read after the 410 sends no ETag of the refused token's answer.
    expect(reads[2]!.init.headers["if-none-match"]).toBeUndefined();
    expect(reads[2]!.url.searchParams.get("timeMin")).toBe(localDay(clock, 0));
  });

  it("sends the last answer's ETag as If-None-Match; a 304 reuses the stored events", async () => {
    const { http, source, clock } = setup();
    const t = (o: number) => localDay(clock, o);
    let n = 0;
    http.events = (_c, _p, headers) => {
      n += 1;
      if (headers["if-none-match"] === '"v1"') return { status: 304 };
      return { status: 200, body: { items: [timed("a", t(1), t(2))], nextSyncToken: "s1" }, etag: '"v1"' };
    };
    const first = await source.events(syncWindow(clock));
    const second = await source.events(syncWindow(clock));
    expect(n).toBe(2);
    expect(http.eventReads().map((r) => r.init.headers["if-none-match"])).toEqual([undefined, '"v1"']);
    expect(second).toEqual(first);
    expect(second.map((e) => e.id)).toEqual(["a"]);
  });

  it("a new day moves the window and runs a full read", async () => {
    const { http, source, clock } = setup();
    await source.events(syncWindow(clock));
    clock.advance(86_400_000);
    await source.events(syncWindow(clock));
    const second = http.eventReads()[1]!;
    expect(second.url.searchParams.get("syncToken")).toBeNull();
    expect(second.url.searchParams.get("timeMin")).toBe(localDay(clock, 0));
    expect(second.init.headers["if-none-match"]).toBeUndefined();
  });
});

describe("google-calendar: secrets and errors", () => {
  it("reads the three credentials only through the SecretStore, under their declared names", async () => {
    const { store, source, clock } = setup();
    await source.events(syncWindow(clock));
    expect([...store.gets].sort()).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
    expect((descriptor.secrets ?? []).map((d) => d.name)).toEqual(["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(REGISTRY.calendar.secrets["google-calendar"]!.map((d) => d.name)).toEqual(["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });

  it("a missing secret throws, naming it", async () => {
    const { source, clock, http } = setup([], { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" });
    expect(await errorOf(source.events(syncWindow(clock)))).toBe("google-calendar: GOOGLE_REFRESH_TOKEN is not set in the SecretStore");
    expect(http.requests).toEqual([]);
  });

  it("errors never quote a secret value or a response body", async () => {
    const leaks = [...Object.values(SECRETS), "access-1", "BODY-MARKER"];
    const cases: ((h: FakeHttp) => void)[] = [
      (h) => (h.token = () => ({ status: 400, body: { error: "invalid_grant BODY-MARKER refresh-secret-value" } })),
      (h) => (h.token = () => ({ status: 200, body: "not json BODY-MARKER" })),
      (h) => (h.token = () => ({ status: 200, body: { scope: "BODY-MARKER", access_token: "access-1", expires_in: 3600 } })),
      (h) => (h.events = () => ({ status: 500, body: { error: "BODY-MARKER" } })),
      (h) => (h.events = () => ({ status: 403, body: "BODY-MARKER client-secret-value" })),
      (h) => (h.events = () => ({ status: 200, body: "<html>BODY-MARKER" })),
      (h) => {
        const real = h.client;
        (h as { client: HttpClient }).client = async (url, init) => {
          if (url !== TOKEN_URL) return real(url, init);
          throw new Error(`fetch failed: ${init.body ?? ""} BODY-MARKER`);
        };
      },
    ];
    for (const arrange of cases) {
      const clock = new FakeClock(NOW);
      const http = new FakeHttp();
      arrange(http);
      const source = new GoogleCalendarSource({ http: http.client, now: () => clock.now(), secrets: new RecordingSecrets(SECRETS), names: NAMES, calendarIds: [] });
      const message = await errorOf(source.events(syncWindow(clock)));
      expect(message).toMatch(/^google-calendar: /);
      for (const leak of leaks) expect(message).not.toContain(leak);
    }
  });

  it("a failed token refresh or read throws, so the sync stores the error and keeps the last events", async () => {
    const { store } = await newStore(new FakeClock(NOW));
    const db = (store as unknown as { db: SqlDriver }).db;
    const { http, source, clock } = setup();
    http.events = () => ({ status: 200, body: { items: [timed("a", localDay(clock, 1), localDay(clock, 2))], nextSyncToken: "s1" } });
    const feeds = [{ name: "google-calendar", source }];
    expect(await syncCalendars(db, feeds, clock.now().getTime())).toMatchObject([{ source: "google-calendar", ok: true }]);

    http.events = () => ({ status: 500 });
    clock.advance(CALENDAR_SYNC_MS);
    const [readFail] = await syncCalendars(db, feeds, clock.now().getTime());
    expect(readFail).toMatchObject({ ok: false, error: "google-calendar: events read of calendar primary failed (HTTP 500)" });

    clock.advance(3600_000); // the access token expires; its refresh fails
    http.token = () => ({ status: 401 });
    const [tokenFail] = await syncCalendars(db, feeds, clock.now().getTime());
    expect(tokenFail).toMatchObject({ ok: false, error: "google-calendar: token refresh failed (HTTP 401)" });

    expect(await db.all("SELECT event_id FROM calendar_events WHERE source = 'google-calendar'")).toEqual([{ event_id: "a" }]);
    expect(await db.all("SELECT error FROM calendar_sync_state WHERE source = 'google-calendar'")).toEqual([{ error: "google-calendar: token refresh failed (HTTP 401)" }]);
  });
});

describe("google-calendar: startup", () => {
  const SQLITE = { ...(JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>), store: { type: "sqlite" } };

  function root(config: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-google-calendar-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
    return dir;
  }

  it("is registered as a calendar plugin and builds from the `calendar` key with no network call", async () => {
    expect(Object.keys(REGISTRY.calendar.plugins)).toContain("google-calendar");
    const loaded = await loadConfig(root({ ...SQLITE, calendar: ["google-calendar"], calendar_ids: ["work@example.com"] }));
    const built = await build(loaded, { clock: new FakeClock(NOW), repoLookup: fakeRepoLookup });
    try {
      const [entry] = built.controller.kernel.d.calendar;
      expect(entry!.name).toBe("google-calendar");
      expect((entry!.source as GoogleCalendarSource<string>).calendars).toEqual(["work@example.com"]);
    } finally {
      await built.close();
    }
  });

  it("a calendar_ids value that is not a list of non-empty strings fails startup", async () => {
    for (const bad of ["primary", [""], [3]]) {
      const loaded = await loadConfig(root({ ...SQLITE, calendar: ["google-calendar"], calendar_ids: bad }));
      const err = await build(loaded, { clock: new FakeClock(NOW), repoLookup: fakeRepoLookup }).then((b) => b.close().then(() => ""), (e: Error) => e.message);
      expect(err).toMatch(/calendar_ids must be a list of non-empty calendar ID strings/);
    }
  });
});
