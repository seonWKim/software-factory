import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleCalendarConnect } from "../src/calendar/plugins/google-calendar/google-calendar-connect.js";
import { CALENDAR_READONLY_SCOPE, EVENTS_API, GoogleCalendarSource, type HttpClient, TOKEN_URL } from "../src/calendar/plugins/google-calendar/google-calendar-source.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } from "../src/calendar/plugins/google-calendar/google-calendar.plugin.js";
import { type Loaded, buildStatsStore, loadConfig, settingsBase } from "../src/compose.js";
import type { LogFields, Logger } from "../src/core/log.js";
import { resolveSettings } from "../src/core/settings.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import { uiCalendar } from "../src/ui/calendar-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { FakeCalendarSource, calendarEvent } from "./calendar/fakes.js";

// The Settings page's Calendar section (design 08-settings, 2026-11-13; docs/plugins/calendar-source.md): GET
// /api/v1/calendar lists the calendar plugins from the registry's connect hooks; POST /api/v1/calendar/connect and
// /disconnect run the one connect flow the CLI runs, behind the write routes' guards and the owner check. No test calls
// Google or opens a browser: the token endpoint and the event reads are a fake HTTP client, the test plays the browser
// by calling the hook's 127.0.0.1 listener as Google's redirect would, and the 5-minute timeout runs on a FakeClock
// that never reaches it.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const NAMES = { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
const NOW = "2026-11-12T12:00:00.000Z";
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:owner@example.com" as UserId;
const OTHER = "local:other@example.com" as UserId;
const PLUGIN = "google-calendar";

const CLIENT_ID = "fake-client-id-0451.example";
const CLIENT_SECRET = "fake-client-secret-77a1";
const REFRESH = "fake-refresh-token-91be";
const ACCESS = "fake-access-token-3c0d";
const CODE = "fake-auth-code-5e2f";
const SECRETS = [CLIENT_SECRET, REFRESH, ACCESS];

const consoleLines: string[] = [];
beforeEach(() => {
  consoleLines.length = 0;
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(" ")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

class MemLog implements Logger {
  lines: string[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push(`${msg} ${JSON.stringify(fields ?? {})}`);
  }
  warn(msg: string, fields?: LogFields) {
    this.info(msg, fields);
  }
  error(msg: string, fields?: LogFields) {
    this.info(msg, fields);
  }
}

/** Google's token endpoint and event reads, faked. `exchange` answers the authorization-code grant. */
class FakeGoogle {
  exchanges = 0;
  exchange: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE, token_type: "Bearer" },
  });
  readonly client: HttpClient = async (url, init) => {
    let status = 200;
    let body: unknown;
    if (url === TOKEN_URL) {
      if (new URLSearchParams(init.body).get("grant_type") === "authorization_code") {
        this.exchanges++;
        ({ status, body } = this.exchange());
      } else body = { access_token: ACCESS, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE };
    } else if (url.startsWith(EVENTS_API)) {
      const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
      body = { items: [1, 2].map((i) => ({ id: `e${i}`, summary: `event ${i}`, start: { dateTime: at(2 + i) }, end: { dateTime: at(3 + i) } })), nextSyncToken: "s1" };
    } else throw new Error(`unexpected request ${url}`);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}

interface Page {
  dir: string;
  secretsFile: string;
  configFile: string;
  google: FakeGoogle;
  store: FactoryStore;
  loaded: Loaded;
  d: ApiDeps;
  settings: UiSettings;
  log: MemLog;
  /** Every response body the test read, for the no-secret check. */
  bodies: string[];
  get(path: string): Promise<{ status: number; value: Record<string, unknown> }>;
  post(path: string, body: unknown, over?: Partial<UiRequest>): Promise<{ status: number; value: Record<string, unknown> }>;
  listed(): Promise<readonly string[]>;
  close(): Promise<void>;
}

/** A machine after `npm run setup`: a secret file with `secrets`, no calendar, the owner signed in on the page as `as`. */
async function page(o: { secrets?: string; calendar?: string[]; as?: UserId } = {}): Promise<Page> {
  const dir = mkdtempSync(join(tmpdir(), "sf-ui-calendar-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const config: Record<string, unknown> = { ...REAL, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" };
  if (o.calendar) config.calendar = o.calendar;
  const configFile = join(dir, "factory.config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(dir, "secrets"), { mode: 0o700 });
  const secretsFile = join(dir, "secrets", ".env");
  writeFileSync(secretsFile, o.secrets ?? "GITHUB_TOKEN=gh\n", { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", secretsFile);

  const google = new FakeGoogle();
  const entry = REGISTRY.calendar;
  const registry: Registry = withPlugin(
    {
      ...REGISTRY,
      calendar: {
        ...entry,
        plugins: { ...entry.plugins, [PLUGIN]: (c) => new GoogleCalendarSource({ http: google.client, now: () => c.clock.now(), secrets: c.secrets, names: NAMES, calendarIds: [] }) },
        connects: { ...entry.connects, [PLUGIN]: googleCalendarConnect({ http: google.client, names: NAMES }) },
      },
    },
    "calendar",
    "work",
    () => new FakeCalendarSource([calendarEvent("w1")]),
  );
  const loaded = await loadConfig(dir, { registry });
  mkdirSync(join(loaded.stateDir, "db"), { recursive: true });
  const store = await buildStatsStore(loaded);
  await store.migrate();
  await store.claimLocalOwner(OWNER);
  const clock = new FakeClock(NOW);
  const base = settingsBase(loaded);
  const settings: UiSettings = {
    base, repo: { owner: "o", name: "r" }, actor: OWNER, resolveProject: async () => null, csrfToken: newCsrfToken(),
    calendar: uiCalendar(loaded, { store, actor: OWNER, clock, base }),
  };
  const log = new MemLog();
  const pauses: UiPauses = { principal: async () => o.as ?? OWNER, authorize: async () => ({ allow: true }), csrfToken: settings.csrfToken, log };
  const d: ApiDeps = {
    store, clock, lease_ms: 300_000, settings, pauses,
    // The scanner knows no calendar secret: a value in a response would show, not be withheld.
    scanner: new PatternEgressScanner(async () => []),
    health: new HealthMonitor(async () => [], clock),
  };
  const bodies: string[] = [];
  const parsed = (r: { status: number; body: string }) => (bodies.push(r.body), { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> });
  return {
    dir, secretsFile, configFile, google, store, loaded, d, settings, log, bodies,
    get: async (path) => parsed(await respond(d, { method: "GET", url: path, host: HOST })),
    post: async (path, body, over = {}) =>
      parsed(await respond(d, { method: "POST", url: path, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: settings.csrfToken, body: JSON.stringify(body), ...over })),
    listed: async () => resolveSettings(base, await store.listSettingOverrides()).values.calendar,
    close: () => store.close(),
  };
}

const CONNECT = "/api/v1/calendar/connect";
const DISCONNECT = "/api/v1/calendar/disconnect";
const read = (f: string) => readFileSync(f, "utf8");

/** Google's redirect back to the hook's listener, as the browser would follow it after consent. */
const redirect = (consent: string, query: (u: URL) => Record<string, string>) => {
  const u = new URL(consent);
  return fetch(`${u.searchParams.get("redirect_uri")}?${new URLSearchParams(query(u))}`).then((r) => r.text());
};
const consented = (u: URL) => ({ code: CODE, state: u.searchParams.get("state")! });

/** The plugin's row in GET /api/v1/calendar once its sign-in is no longer open. */
async function settled(p: Page) {
  let row: Record<string, unknown> | undefined;
  await vi.waitFor(async () => {
    const v = (await p.get("/api/v1/calendar")).value as { plugins: Record<string, unknown>[] };
    row = v.plugins.find((x) => x.name === PLUGIN);
    expect((row?.attempt as { state?: string } | null)?.state).not.toBe("signing_in");
  });
  return row!;
}

describe("GET /api/v1/calendar", () => {
  it("lists each calendar plugin with a connect hook, from the registry, not connected on a fresh setup", async () => {
    const p = await page();
    try {
      const r = await p.get("/api/v1/calendar");
      expect(r.status).toBe(200);
      expect(r.value.plugins).toEqual([{ name: PLUGIN, connected: false, synced_at: null, error: null, attempt: null }]);
    } finally {
      await p.close();
    }
  });
});

describe("POST /api/v1/calendar/connect: a fresh setup, end to end", () => {
  it("asks for the client ID and secret, signs in, stores the three secrets, lists the plugin live, syncs, and the Tasks page shows the events", async () => {
    const p = await page();
    try {
      const before = { secrets: read(p.secretsFile), config: read(p.configFile) };
      // No values: the hook's two questions come back as inputs to ask for; nothing is written, no sign-in opens.
      const ask = await p.post(CONNECT, { plugin: PLUGIN });
      expect(ask).toEqual({ status: 200, value: { plugin: PLUGIN, state: "needs_input", needs: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] } });
      expect(read(p.secretsFile)).toBe(before.secrets);
      expect(await p.listed()).toEqual([]);
      expect((await settled(p)).attempt).toBeNull();

      const start = await p.post(CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } });
      expect(start.status).toBe(202);
      expect(start.value).toMatchObject({ plugin: PLUGIN, state: "signing_in" });
      const consent = String(start.value.consent_url);
      expect((await p.get("/api/v1/calendar")).value.plugins).toMatchObject([{ attempt: { state: "signing_in" } }]);
      await redirect(consent, consented);

      const row = await settled(p);
      expect(row).toMatchObject({ connected: true, error: null, attempt: { state: "connected", events: 2, error: null } });
      expect(row.synced_at).toBe(NOW);
      expect(read(p.secretsFile)).toBe(`GITHUB_TOKEN=gh\n\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nGOOGLE_REFRESH_TOKEN=${REFRESH}`);
      expect(statSync(p.secretsFile).mode & 0o777).toBe(0o600);
      expect(await p.listed()).toEqual([PLUGIN]);
      // The live setting, never the file: the controller picks it up on its next refresh.
      expect(read(p.configFile)).toBe(before.config);
      expect((await p.store.listSettingChanges(10)).map((c) => [c.key, c.actor, c.new_value])).toEqual([["calendar", OWNER, '["google-calendar"]']]);

      const tasks = await p.get("/api/v1/tasks");
      expect(JSON.stringify(tasks.value)).toContain("event 1");
      expect(JSON.stringify(tasks.value)).toContain("event 2");
    } finally {
      await p.close();
    }
  });

  it("the consent URL asks for calendar.readonly only, with PKCE S256, a random state and a redirect to 127.0.0.1 on the callback path", async () => {
    const p = await page({ secrets: `GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n` });
    try {
      const urls: URL[] = [];
      for (let i = 0; i < 2; i++) {
        // The client is in the secret file: no input is asked for.
        const start = await p.post(CONNECT, { plugin: PLUGIN });
        expect(start.status).toBe(202);
        urls.push(new URL(String(start.value.consent_url)));
        await redirect(String(start.value.consent_url), consented);
        await settled(p);
      }
      for (const u of urls) {
        expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
        expect(u.searchParams.getAll("scope")).toEqual([CALENDAR_READONLY_SCOPE]);
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
        const back = new URL(u.searchParams.get("redirect_uri")!);
        expect(back.protocol).toBe("http:");
        expect(back.hostname).toBe("127.0.0.1");
        expect(back.pathname).toBe("/callback");
      }
      expect(urls[0]!.searchParams.get("state")).not.toBe(urls[1]!.searchParams.get("state"));
    } finally {
      await p.close();
    }
  });

  it("a second connect while a sign-in is open is refused (409)", async () => {
    const p = await page({ secrets: `GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n` });
    try {
      const start = await p.post(CONNECT, { plugin: PLUGIN });
      expect((await p.post(CONNECT, { plugin: PLUGIN })).status).toBe(409);
      expect((await p.post(DISCONNECT, { plugin: PLUGIN })).status).toBe(409);
      await redirect(String(start.value.consent_url), consented);
      expect((await settled(p)).attempt).toMatchObject({ state: "connected" });
    } finally {
      await p.close();
    }
  });
});

describe("POST /api/v1/calendar/connect: refusals write nothing", () => {
  const cases: { name: string; arrange?: (g: FakeGoogle) => void; query?: (u: URL) => Record<string, string>; error: RegExp }[] = [
    { name: "a wrong state", query: () => ({ code: CODE, state: "not-the-state" }), error: /state did not match/ },
    { name: "an error from Google", query: (u) => ({ error: "access_denied", state: u.searchParams.get("state")! }), error: /consent answered an error \(access_denied\)/ },
    {
      name: "a scope other than exactly calendar.readonly",
      arrange: (g) => (g.exchange = () => ({ status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: `${CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar` } })),
      error: /scope other than exactly calendar\.readonly/,
    },
    {
      name: "a missing refresh token",
      arrange: (g) => (g.exchange = () => ({ status: 200, body: { access_token: ACCESS, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE } })),
      error: /carried no refresh token/,
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const p = await page({ calendar: ["work"] });
      try {
        c.arrange?.(p.google);
        const before = { secrets: read(p.secretsFile), config: read(p.configFile) };
        const start = await p.post(CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } });
        expect(start.status).toBe(202);
        await redirect(String(start.value.consent_url), c.query ?? consented);
        const row = await settled(p);
        expect(row).toMatchObject({ connected: false, attempt: { state: "failed", events: null } });
        expect(String((row.attempt as { error: string }).error)).toMatch(c.error);
        expect(read(p.secretsFile)).toBe(before.secrets);
        expect(read(p.configFile)).toBe(before.config);
        expect(await p.listed()).toEqual(["work"]);
        expect(await p.store.listSettingOverrides()).toEqual([]);
      } finally {
        await p.close();
      }
    });
  }
});

describe("POST /api/v1/calendar/disconnect", () => {
  it("removes the three secrets and the plugin's name; other lines and names stay", async () => {
    const p = await page({
      secrets: `GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nOTHER=x\nGOOGLE_REFRESH_TOKEN=${REFRESH}\n`,
      calendar: ["work", PLUGIN],
    });
    try {
      const config = read(p.configFile);
      expect(await p.post(DISCONNECT, { plugin: PLUGIN })).toEqual({ status: 200, value: { plugin: PLUGIN, connected: false } });
      expect(read(p.secretsFile)).toBe("GITHUB_TOKEN=gh\nOTHER=x\n");
      expect(statSync(p.secretsFile).mode & 0o777).toBe(0o600);
      expect(await p.listed()).toEqual(["work"]);
      expect(read(p.configFile)).toBe(config);
      expect((await p.get("/api/v1/calendar")).value.plugins).toMatchObject([{ name: PLUGIN, connected: false }]);
      expect(p.google.exchanges).toBe(0);
    } finally {
      await p.close();
    }
  });
});

describe("the calendar routes' guards", () => {
  const routes = [
    [CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } }],
    [DISCONNECT, { plugin: PLUGIN }],
  ] as const;

  it("refuse a bad Host or Origin, a missing or wrong token, a non-JSON body type and a user who is not the owner; nothing is written", async () => {
    const secrets = `GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nGOOGLE_REFRESH_TOKEN=${REFRESH}\n`;
    const p = await page({ secrets, calendar: [PLUGIN] });
    const other = await page({ secrets, calendar: [PLUGIN], as: OTHER });
    try {
      for (const [path, body] of routes) {
        expect((await p.post(path, body, { host: "evil.example:4310" })).status, `${path} host`).toBe(403);
        expect((await p.post(path, body, { origin: "http://evil.example" })).status, `${path} origin`).toBe(403);
        expect((await p.post(path, body, { origin: undefined })).status, `${path} no origin`).toBe(403);
        expect((await p.post(path, body, { csrfToken: undefined })).status, `${path} no token`).toBe(403);
        expect((await p.post(path, body, { csrfToken: "stale" })).status, `${path} stale token`).toBe(403);
        expect((await p.post(path, body, { contentType: "text/plain" })).status, `${path} content type`).toBe(415);
        const refused = await other.post(path, body);
        expect(refused.status, `${path} not the owner`).toBe(403);
        expect(String(refused.value.error)).toContain("Only the owner");
      }
      for (const x of [p, other]) {
        expect(read(x.secretsFile)).toBe(secrets);
        expect(await x.store.listSettingOverrides()).toEqual([]);
        expect((await x.get("/api/v1/calendar")).value.plugins).toMatchObject([{ connected: true, attempt: null }]);
      }
      expect(p.google.exchanges + other.google.exchanges).toBe(0);
    } finally {
      await p.close();
      await other.close();
    }
  });

  it("refuse a body that names no connectable plugin or an undeclared secret (400)", async () => {
    const p = await page();
    try {
      expect((await p.post(CONNECT, { plugin: "work" })).status).toBe(400);
      expect((await p.post(CONNECT, { plugin: PLUGIN, values: { GITHUB_TOKEN: "x" } })).status).toBe(400);
      expect((await p.post(CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: "" } })).status).toBe(400);
      expect((await p.post(DISCONNECT, { plugin: PLUGIN, values: {} })).status).toBe(400);
      expect((await p.post(CONNECT, [])).status).toBe(400);
    } finally {
      await p.close();
    }
  });
});

describe("no secret leaves", () => {
  it("no response, log line or store row holds the client secret, the refresh token or the access token", async () => {
    const p = await page();
    try {
      await p.post(CONNECT, { plugin: PLUGIN });
      const start = await p.post(CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } });
      await redirect(String(start.value.consent_url), consented);
      await settled(p);
      await p.get("/api/v1/tasks");
      await p.get("/api/v1/settings");
      await p.post(DISCONNECT, { plugin: PLUGIN });
      await p.get("/api/v1/calendar");
      // A refused connect too: its error reaches the page.
      p.google.exchange = () => ({ status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar" } });
      const again = await p.post(CONNECT, { plugin: PLUGIN, values: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } });
      await redirect(String(again.value.consent_url), consented);
      await settled(p);

      const out = [...p.bodies, ...p.log.lines, ...consoleLines].join("\n");
      expect(p.bodies.length).toBeGreaterThan(5);
      for (const value of SECRETS) expect(out.includes(value), value).toBe(false);
      for (const t of await p.store.listTables()) {
        const rows = JSON.stringify(await storeSql(p.store).all(`SELECT * FROM ${t.name}`));
        for (const value of SECRETS) expect(rows.includes(value), `${value} in ${t.name}`).toBe(false);
      }
    } finally {
      await p.close();
    }
  });
});
