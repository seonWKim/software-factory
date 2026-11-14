import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectDeps, connectSetup } from "../../src/cli/handlers/setup/guided.js";
import type { GoogleClient } from "../../src/calendar/plugins/google-calendar/default-client.js";
import { CONNECT_TIMEOUT_MS, challengeOf, googleCalendarConnect, onlyReadonly } from "../../src/calendar/plugins/google-calendar/google-calendar-connect.js";
import {
  CALENDAR_READONLY_SCOPE,
  EVENTS_API,
  GoogleCalendarSource,
  type HttpClient,
  TOKEN_URL,
} from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_HTTP_TIMEOUT_MS, GOOGLE_REFRESH_TOKEN } from "../../src/calendar/plugins/google-calendar/google-calendar.plugin.js";
import { buildStatsStore, loadConfig, settingsBase } from "../../src/compose.js";
import { resolveSettings } from "../../src/core/settings.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { storeSql } from "../../src/impl/store/sql/store-sql.js";
import { REGISTRY, type Registry, withPlugin } from "../../src/plugins.js";
import type { SetupIo } from "../../src/setup.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";

// `factory setup calendar google` and `--disconnect` (docs/plugins/calendar-source.md, Turn on), end to end through
// the generic CLI flow, which runs the same connect flow as the dashboard (src/setup.ts connectCalendar) and writes the
// live `calendar` setting, never factory.config.json. No test calls Google or opens a browser: the token endpoint and the event reads are a fake
// HTTP client, the browser is a fake opener that calls the loopback listener on 127.0.0.1 the way Google's redirect
// would, the 5-minute timeout runs on a FakeClock, and the factory's default client is a fake one.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const NAMES = { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
const NOW = "2026-11-12T12:00:00.000Z";

/** The factory's default client, as this build would carry it. */
const DEFAULT: GoogleClient = { id: "fake-default-client-id-77.example", secret: "fake-default-client-secret-e3b9" };
const CLIENT_ID = "fake-client-id-0451.example";
const CLIENT_SECRET = "fake-client-secret-77a1";
const REFRESH = "fake-refresh-token-91be";
const ACCESS = "fake-access-token-3c0d";
const CODE = "fake-auth-code-5e2f";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const console_: string[] = [];
beforeEach(() => {
  console_.length = 0;
  for (const m of ["log", "error", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void console_.push(a.join(" ")));
});

/** Google's token endpoint and event reads, faked. `exchange` answers the authorization-code grant. */
class FakeGoogle {
  readonly bodies: URLSearchParams[] = [];
  exchange: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE, token_type: "Bearer" },
  });
  eventsStatus = 200;
  /** Awaited before the exchange answers: a hung Google never settles it. */
  beforeExchange: () => Promise<void> = async () => undefined;
  readonly client: HttpClient = async (url, init) => {
    let status = 200;
    let body: unknown;
    if (url === TOKEN_URL) {
      const b = new URLSearchParams(init.body);
      this.bodies.push(b);
      if (b.get("grant_type") === "authorization_code") {
        await this.beforeExchange();
        ({ status, body } = this.exchange());
      }
      else body = { access_token: ACCESS, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE };
    } else if (url.startsWith(EVENTS_API)) {
      status = this.eventsStatus;
      const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
      body = { items: [1, 2].map((i) => ({ id: `e${i}`, summary: `event ${i}`, start: { dateTime: at(20 + i) }, end: { dateTime: at(21 + i) } })), nextSyncToken: "s1" };
    } else throw new Error(`unexpected request ${url}`);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  exchanges() {
    return this.bodies.filter((b) => b.get("grant_type") === "authorization_code");
  }
}

interface Run {
  dir: string;
  secretsFile: string;
  configFile: string;
  google: FakeGoogle;
  clock: FakeClock;
  urls: string[];
  printed: string[];
  hiddenPrompts: string[];
  /** What the fake browser does with the consent URL: by default, Google's redirect with the code and the state. */
  browser: (url: URL) => Promise<void>;
  run(args?: { disconnect?: boolean }): Promise<number>;
  load(): ReturnType<typeof loadConfig>;
}

const redirect = (url: URL, query: Record<string, string>) =>
  fetch(`${url.searchParams.get("redirect_uri")}?${new URLSearchParams(query)}`).then((r) => r.text());

/** `defaultClient`: the default client the build carries (DEFAULT when left out; null: none). */
function machine(o: { secrets?: string | null; calendar?: unknown; registry?: (r: Registry) => Registry; defaultClient?: GoogleClient | null } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "sf-calendar-connect-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const config: Record<string, unknown> = { ...REAL, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" };
  if (o.calendar !== undefined) config.calendar = o.calendar;
  const configFile = join(dir, "factory.config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(dir, "secrets"), { mode: 0o700 });
  const secretsFile = join(dir, "secrets", ".env");
  if (o.secrets !== null) writeFileSync(secretsFile, o.secrets ?? "GITHUB_TOKEN=gh\n", { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", secretsFile);

  const google = new FakeGoogle();
  const entry = REGISTRY.calendar;
  let registry: Registry = {
    ...REGISTRY,
    calendar: {
      ...entry,
      plugins: {
        ...entry.plugins,
        "google-calendar": (c) => new GoogleCalendarSource({ http: google.client, now: () => c.clock.now(), secrets: c.secrets, names: NAMES, calendarIds: [] }),
      },
      connects: { ...entry.connects, "google-calendar": googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => (o.defaultClient === undefined ? DEFAULT : o.defaultClient) }) },
    },
  };
  registry = o.registry?.(registry) ?? registry;
  const r: Run = {
    dir, secretsFile, configFile, google,
    clock: new FakeClock(NOW),
    urls: [], printed: [], hiddenPrompts: [],
    browser: async (url) => void (await redirect(url, { code: CODE, state: url.searchParams.get("state")! })),
    load: () => loadConfig(dir, { registry }),
    async run(args = {}) {
      const ctx = { name: "setup", usage: "", load: r.load };
      const hidden = [CLIENT_ID, CLIENT_SECRET];
      const io: SetupIo = {
        ask: {
          interactive: true,
          choose: async (_q, _o, d) => d,
          yesNo: async () => true,
          text: async (_q, d) => d,
        },
        secret: async (p) => (r.hiddenPrompts.push(p), hidden.shift()!),
        print: (l) => void r.printed.push(l),
      };
      const deps: ConnectDeps = { io, clock: r.clock, openBrowser: async (u) => (r.urls.push(u), r.browser(new URL(u))) };
      return connectSetup(ctx, { kind: "calendar", command: "google", disconnect: args.disconnect === true }, deps);
    },
  };
  return r;
}

const read = (f: string) => readFileSync(f, "utf8");

/** The effective `calendar` list: the live setting's override, else the file's key. */
async function listed(r: Run): Promise<readonly string[]> {
  const loaded = await r.load();
  const store = await buildStatsStore(loaded);
  try {
    await store.migrate();
    return resolveSettings(settingsBase(loaded), await store.listSettingOverrides()).values.calendar;
  } finally {
    await store.close();
  }
}

/** Every file under `dir` but `skip`, as text. */
function filesUnder(dir: string, skip: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && join(e.parentPath, e.name) !== skip)
    .map((e) => ({ path: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), "latin1") }));
}

describe("factory setup calendar google: the consent", () => {
  it("asks only for calendar.readonly, redirects to 127.0.0.1 on a loopback port, and carries a PKCE S256 challenge and a random state", async () => {
    const a = machine();
    expect(await a.run()).toBe(0);
    const b = machine({ secrets: `GOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n` });
    expect(await b.run()).toBe(0);
    const [ua, ub] = [new URL(a.urls[0]!), new URL(b.urls[0]!)];
    for (const u of [ua, ub]) {
      expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(u.searchParams.get("scope")).toBe(CALENDAR_READONLY_SCOPE);
      expect(u.searchParams.getAll("scope")).toHaveLength(1);
      expect(u.searchParams.get("response_type")).toBe("code");
      const redirectUri = new URL(u.searchParams.get("redirect_uri")!);
      expect(redirectUri.protocol).toBe("http:");
      expect(redirectUri.hostname).toBe("127.0.0.1");
      expect(Number(redirectUri.port)).toBeGreaterThan(0);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
    // A fresh state and verifier per run.
    expect(ua.searchParams.get("state")).not.toBe(ub.searchParams.get("state"));
    // No client lines: the default client; both lines: the owner's own.
    expect([ua.searchParams.get("client_id"), ub.searchParams.get("client_id")]).toEqual([DEFAULT.id, CLIENT_ID]);
    expect(ua.searchParams.get("code_challenge")).not.toBe(ub.searchParams.get("code_challenge"));
    // The challenge is the S256 of the verifier the exchange sends, with the code and the same redirect.
    const [ex] = a.google.exchanges();
    expect(ex!.get("code")).toBe(CODE);
    expect(ex!.get("redirect_uri")).toBe(ua.searchParams.get("redirect_uri"));
    expect([ex!.get("client_id"), ex!.get("client_secret")]).toEqual([DEFAULT.id, DEFAULT.secret]);
    expect(challengeOf(ex!.get("code_verifier")!)).toBe(ua.searchParams.get("code_challenge"));
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("compares the granted scope as a set of space-separated scopes", () => {
    expect(onlyReadonly(CALENDAR_READONLY_SCOPE)).toBe(true);
    expect(onlyReadonly(` ${CALENDAR_READONLY_SCOPE}  ${CALENDAR_READONLY_SCOPE} `)).toBe(true);
    for (const s of [`${CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar`, "https://www.googleapis.com/auth/calendar", "", undefined, 1]) {
      expect(onlyReadonly(s), String(s)).toBe(false);
    }
  });
});

describe("factory setup calendar google: end to end", () => {
  it("with no client lines uses the default client and asks nothing; stores the three secrets; lists the plugin in the live setting; syncs once and prints the count", async () => {
    // `npm run setup` leaves empty lines for every declared secret: they count as no client.
    const r = machine({ secrets: "GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\n" });
    const config = read(r.configFile);
    expect(await r.run()).toBe(0);
    expect(r.hiddenPrompts).toEqual([]);
    expect(r.printed.join("\n")).toContain("using the factory's Google client");
    expect(read(r.secretsFile)).toBe(`GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${DEFAULT.id}\nGOOGLE_CLIENT_SECRET=${DEFAULT.secret}\n\nGOOGLE_REFRESH_TOKEN=${REFRESH}`);
    expect(statSync(r.secretsFile).mode & 0o777).toBe(0o600);
    expect(await listed(r)).toEqual(["google-calendar"]);
    expect(read(r.configFile)).toBe(config);
    expect(r.printed).toContain('   ✓ listed google-calendar in "calendar": ["google-calendar"] (a live setting, no restart)');
    expect(r.printed).toContain("   ✓ synced google-calendar: read 2 events");
    // The sync wrote the store.
    const store = await buildStatsStore(await loadConfig(r.dir));
    try {
      expect(await storeSql(store).all("SELECT event_id FROM calendar_events WHERE source = ? ORDER BY event_id", ["google-calendar"])).toEqual([{ event_id: "e1" }, { event_id: "e2" }]);
    } finally {
      await store.close();
    }
  });

  it("a build with no default client asks the client ID and secret once, hidden", async () => {
    const r = machine({ defaultClient: null });
    expect(await r.run()).toBe(0);
    expect(r.hiddenPrompts).toEqual(["   Paste GOOGLE_CLIENT_ID (hidden): ", "   Paste GOOGLE_CLIENT_SECRET (hidden): "]);
    expect(read(r.secretsFile)).toBe(`GITHUB_TOKEN=gh\n\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nGOOGLE_REFRESH_TOKEN=${REFRESH}`);
    expect(statSync(r.secretsFile).mode & 0o777).toBe(0o600);
  });

  it("uses the owner's own client when the secret file holds both lines, without asking (the advanced path)", async () => {
    const r = machine({ secrets: `GOOGLE_CLIENT_ID=${CLIENT_ID}\nexport GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nOTHER=x\n` });
    expect(await r.run()).toBe(0);
    expect(r.hiddenPrompts).toEqual([]);
    expect(r.google.exchanges()[0]!.get("client_secret")).toBe(CLIENT_SECRET);
    expect(r.printed.join("\n")).toContain("using your own client");
    expect(read(r.secretsFile)).toBe(`GOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nOTHER=x\n\nGOOGLE_REFRESH_TOKEN=${REFRESH}`);
  });

  it("puts no secret, token, code or verifier in the output, the store or any file but the secret file", async () => {
    const r = machine();
    expect(await r.run()).toBe(0);
    const verifier = r.google.exchanges()[0]!.get("code_verifier")!;
    const output = [...r.printed, ...console_].join("\n");
    const outside = filesUnder(r.dir, r.secretsFile);
    expect(outside.some((f) => f.path.includes(join("state", "db")))).toBe(true);
    for (const value of [DEFAULT.secret, REFRESH, ACCESS, CODE, verifier]) {
      expect(output, value).not.toContain(value);
      for (const f of outside) expect(f.text.includes(value), `${value} in ${f.path}`).toBe(false);
    }
    const store = await buildStatsStore(await loadConfig(r.dir));
    try {
      for (const t of await store.listTables()) {
        const rows = JSON.stringify(await storeSql(store).all(`SELECT * FROM ${t.name}`));
        for (const value of [DEFAULT.secret, REFRESH, ACCESS, CODE, verifier]) expect(rows.includes(value), `${value} in ${t.name}`).toBe(false);
      }
    } finally {
      await store.close();
    }
    // Only the consent URL shows the client ID.
    expect(read(r.secretsFile)).toContain(`GOOGLE_CLIENT_SECRET=${DEFAULT.secret}`);
    expect(output.split("\n").filter((l) => l.includes(DEFAULT.id)).every((l) => l.includes("accounts.google.com"))).toBe(true);
  });
});

describe("factory setup calendar google: refusals store nothing and exit non-zero", () => {
  const untouched = async (r: Run, before: { secrets: string; config: string }) => {
    expect(await r.run()).toBe(1);
    expect(read(r.secretsFile)).toBe(before.secrets);
    expect(read(r.configFile)).toBe(before.config);
    expect(await listed(r)).toEqual([]);
  };
  const snapshot = (r: Run) => ({ secrets: read(r.secretsFile), config: read(r.configFile) });

  it("a granted scope other than exactly calendar.readonly", async () => {
    for (const scope of [`${CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar`, "https://www.googleapis.com/auth/calendar", undefined]) {
      const r = machine();
      r.google.exchange = () => ({ status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope } });
      await untouched(r, snapshot(r));
      expect(r.printed.join("\n")).toMatch(/scope other than exactly calendar\.readonly/);
    }
  });

  it("a callback with a wrong state, before any token request", async () => {
    const r = machine();
    r.browser = async (url) => void (await redirect(url, { code: CODE, state: "not-the-state" }));
    await untouched(r, snapshot(r));
    expect(r.google.exchanges()).toEqual([]);
    expect(r.printed.join("\n")).toMatch(/state did not match/);
  });

  it("no callback within 5 minutes: the listener closes", async () => {
    const r = machine();
    let redirectUri = "";
    r.browser = async (url) => {
      redirectUri = url.searchParams.get("redirect_uri")!;
      r.clock.advance(CONNECT_TIMEOUT_MS - 1);
      await Promise.resolve();
      r.clock.advance(1);
    };
    await untouched(r, snapshot(r));
    expect(r.google.exchanges()).toEqual([]);
    expect(r.printed.join("\n")).toMatch(/no answer from the browser within 5 minutes/);
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("a token exchange with no answer within GOOGLE_HTTP_TIMEOUT_MS fails as no answer", async () => {
    const r = machine();
    let asked = false;
    // Google takes the request and never answers, while the Clock passes the limit.
    r.google.beforeExchange = async () => {
      asked = true;
      r.clock.advance(GOOGLE_HTTP_TIMEOUT_MS - 1);
      await Promise.resolve();
      r.clock.advance(1);
      return new Promise(() => undefined);
    };
    await untouched(r, snapshot(r));
    expect(asked).toBe(true);
    expect(r.printed.join("\n")).toMatch(/token exchange failed \(no answer\): nothing stored/);
  });

  it("a callback that carries an error from Google", async () => {
    const r = machine();
    r.browser = async (url) => void (await redirect(url, { error: "access_denied", state: url.searchParams.get("state")! }));
    await untouched(r, snapshot(r));
    expect(r.printed.join("\n")).toMatch(/consent answered an error \(access_denied\)/);
  });

  it("a token answer with no refresh token, or a failed exchange", async () => {
    for (const answer of [
      { status: 200, body: { access_token: ACCESS, expires_in: 3600, scope: CALENDAR_READONLY_SCOPE } },
      { status: 400, body: { error: "invalid_grant" } },
    ]) {
      const r = machine();
      r.google.exchange = () => answer;
      await untouched(r, snapshot(r));
    }
  });

  it("a missing secret file: says to run npm run setup and creates no file", async () => {
    const r = machine({ secrets: null });
    expect(await r.run()).toBe(1);
    expect(existsSync(r.secretsFile)).toBe(false);
    expect(r.urls).toEqual([]);
    expect(r.printed.join("\n")).toMatch(/run npm run setup/);
  });
});

describe("factory setup calendar google: the calendar setting and the sync", () => {
  const work = (reg: Registry) => withPlugin(reg, "calendar", "work", () => new FakeCalendarSource([calendarEvent("w1")]));

  it("keeps the other calendar names, and factory.config.json byte for byte", async () => {
    const r = machine({ calendar: ["work"], registry: work });
    const before = read(r.configFile);
    expect(await r.run()).toBe(0);
    expect(await listed(r)).toEqual(["work", "google-calendar"]);
    expect(read(r.configFile)).toBe(before);
  });

  it("a plugin the file lists already writes no override", async () => {
    const r = machine({ calendar: ["google-calendar"] });
    expect(await r.run()).toBe(0);
    expect(r.printed).toContain('   ✓ "calendar" unchanged: ["google-calendar"] (a live setting, no restart)');
    const store = await buildStatsStore(await loadConfig(r.dir));
    try {
      expect(await store.listSettingOverrides()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("a failed sync prints its error and exits non-zero; the secrets and the setting stay", async () => {
    const r = machine();
    r.google.eventsStatus = 500;
    expect(await r.run()).toBe(1);
    expect(r.printed.join("\n")).toMatch(/sync of google-calendar failed: google-calendar: events read of calendar primary failed \(HTTP 500\)/);
    expect(read(r.secretsFile)).toContain(`GOOGLE_REFRESH_TOKEN=${REFRESH}`);
    expect(await listed(r)).toEqual(["google-calendar"]);
  });
});

describe("factory setup calendar google --disconnect", () => {
  const CONNECTED = `GITHUB_TOKEN=gh\nGOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\nOTHER=x\nGOOGLE_REFRESH_TOKEN=${REFRESH}\n`;

  it("removes the three secret lines, keeps the others and mode 600, and drops the plugin from the setting, keeping other names", async () => {
    const r = machine({ secrets: CONNECTED, calendar: ["work", "google-calendar"], registry: (reg) => withPlugin(reg, "calendar", "work", () => new FakeCalendarSource()) });
    expect(await r.run({ disconnect: true })).toBe(0);
    expect(read(r.secretsFile)).toBe("GITHUB_TOKEN=gh\nOTHER=x\n");
    expect(statSync(r.secretsFile).mode & 0o777).toBe(0o600);
    expect(await listed(r)).toEqual(["work"]);
    expect(r.urls).toEqual([]);
    expect(r.google.bodies).toEqual([]);
  });

  it("the last name dropped leaves the setting []; factory.config.json stays as it was", async () => {
    const r = machine({ secrets: CONNECTED, calendar: ["google-calendar"] });
    const before = read(r.configFile);
    expect(await r.run({ disconnect: true })).toBe(0);
    expect(await listed(r)).toEqual([]);
    expect(read(r.configFile)).toBe(before);
  });

  it("with nothing connected changes nothing", async () => {
    const r = machine({ secrets: "GITHUB_TOKEN=gh\n" });
    const before = read(r.configFile);
    expect(await r.run({ disconnect: true })).toBe(0);
    expect(read(r.secretsFile)).toBe("GITHUB_TOKEN=gh\n");
    expect(read(r.configFile)).toBe(before);
  });
});
