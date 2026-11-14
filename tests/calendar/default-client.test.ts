// The google-calendar default client (docs/plugins/calendar-source.md, Turn on; docs/setup.md, release builds): a
// release build writes the client secret module into the staged dist/ from a build-time value, the loader reads it
// beside itself, and Connect and the token refresh use it only when the secret file holds neither client value. No
// test calls Google: the token endpoint is a fake HTTP client, the browser a fake opener that calls the loopback
// listener the way Google's redirect would. Every client value here is fake.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_SECRET_MODULE,
  DEFAULT_GOOGLE_CLIENT_ID,
  type DefaultClient,
  loadDefaultClient,
} from "../../src/calendar/plugins/google-calendar/default-client.js";
import { type ConnectCtx, googleCalendarConnect } from "../../src/calendar/plugins/google-calendar/google-calendar-connect.js";
import { CALENDAR_READONLY_SCOPE, EVENTS_API, GoogleCalendarSource, type HttpClient, TOKEN_URL } from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
/** The release build step, typed here: scripts/build.d.mts declares the swap helpers only. */
type BuildScript = { writeDefaultClient(stagedDist: string, value: string | undefined): string | null };
const buildScript = async () => (await import(pathToFileURL(join(REPO_ROOT, "scripts", "build.mjs")).href)) as BuildScript;

const MODULE_PATH = join("calendar", "plugins", "google-calendar", "default-client-secret.js");
const DEFAULT_ID = "fake-default-client-id-7d21.example";
const DEFAULT_SECRET = "fake-default-client-secret-c3f9";
const OWN_ID = "fake-own-client-id-0451.example";
const OWN_SECRET = "fake-own-client-secret-77a1";
const REFRESH = "fake-refresh-token-91be";
const CODE = "fake-auth-code-5e2f";
type Name = "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REFRESH_TOKEN";
const NAMES = { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET", refreshToken: "GOOGLE_REFRESH_TOKEN" } as const;

/** A staged dist/ with the release step run on `value`; returns the folder and the module path, if written. */
async function stagedBuild(value: string | undefined): Promise<{ root: string; staged: string; written: string | null }> {
  const root = mkdtempSync(join(tmpdir(), "sf-default-client-"));
  const staged = join(root, "dist.build-1-1");
  mkdirSync(join(staged, "calendar", "plugins", "google-calendar"), { recursive: true });
  writeFileSync(join(staged, "calendar", "plugins", "google-calendar", "default-client.js"), "// compiled\n");
  return { root, staged, written: (await buildScript()).writeDefaultClient(staged, value) };
}

/** Every file under `dir`, relative to it. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), join(prefix, e.name)) : [join(prefix, e.name)],
  );
}

const fakeDefault = (): DefaultClient => ({ clientId: DEFAULT_ID, clientSecret: { reveal: () => DEFAULT_SECRET } });

/** Google's token endpoint, faked; `refreshStatus` answers the refresh grant. */
class FakeGoogle {
  readonly bodies: URLSearchParams[] = [];
  refreshStatus = 200;
  readonly client: HttpClient = async (url, init) => {
    let status = 200;
    let body: unknown;
    if (url === TOKEN_URL) {
      const b = new URLSearchParams(init.body);
      this.bodies.push(b);
      if (b.get("grant_type") === "authorization_code") body = { refresh_token: REFRESH, access_token: "fake-access", expires_in: 3600, scope: CALENDAR_READONLY_SCOPE };
      else {
        status = this.refreshStatus;
        body = { access_token: "fake-access", expires_in: 3600, scope: CALENDAR_READONLY_SCOPE };
      }
    } else if (url.startsWith(EVENTS_API)) body = { items: [], nextSyncToken: "s1" };
    else throw new Error(`unexpected request ${url}`);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}

interface Run {
  ctx: ConnectCtx<Name>;
  printed: string[];
  asked: string[];
  urls: string[];
  stored: Map<Name, string>[];
}

/** A connect context over a fake secret file holding `file`; the fake browser answers with a code and the state. */
function run(file: Partial<Record<Name, string>>): Run {
  const r: Run = { printed: [], asked: [], urls: [], stored: [], ctx: undefined as unknown as ConnectCtx<Name> };
  r.ctx = {
    secretsFile: "/fake/secrets/.env",
    secrets: { get: async (n) => (file[n] ? { reveal: () => file[n]! } : null) },
    ask: { hidden: async (p) => (r.asked.push(p), p.includes("SECRET") ? OWN_SECRET : OWN_ID) },
    print: (line) => void r.printed.push(line),
    openBrowser: async (url) => {
      r.urls.push(url);
      const u = new URL(url);
      await fetch(`${u.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: CODE, state: u.searchParams.get("state")! })}`).then((x) => x.text());
    },
    storeSecrets: async (values) => void r.stored.push(new Map(values)),
    removeSecrets: async () => undefined,
    clock: { sleep: () => new Promise(() => undefined) },
  };
  return r;
}

const everything = (r: Run, google: FakeGoogle): string =>
  JSON.stringify({ printed: r.printed, urls: r.urls, stored: r.stored.map((m) => [...m]), asked: r.asked, codeGrant: google.bodies.length });

describe("google-calendar default client: the release build step", () => {
  it("with no release value writes no module and nothing else", async () => {
    for (const value of [undefined, "", "   "]) {
      const b = await stagedBuild(value);
      expect(b.written).toBeNull();
      expect(files(b.staged)).toEqual([join("calendar", "plugins", "google-calendar", "default-client.js")]);
      expect(readdirSync(b.root)).toEqual(["dist.build-1-1"]);
    }
  });

  it("with a release value writes the module into the staged dist/, mode 600, and nothing outside it", async () => {
    const b = await stagedBuild(DEFAULT_SECRET);
    expect(b.written).toBe(join(b.staged, MODULE_PATH));
    expect(files(b.staged).sort()).toEqual([join("calendar", "plugins", "google-calendar", "default-client.js"), MODULE_PATH].sort());
    expect(readdirSync(b.root)).toEqual(["dist.build-1-1"]);
    expect(statSync(b.written!).mode & 0o777).toBe(0o600);
    // The loader beside it reads the value back.
    const d = await loadDefaultClient({ clientId: DEFAULT_ID, moduleUrl: pathToFileURL(b.written!).href });
    expect(d?.clientId).toBe(DEFAULT_ID);
    expect(d?.clientSecret.reveal()).toBe(DEFAULT_SECRET);
    // Printing the loaded client never shows the secret.
    expect(JSON.stringify(d)).not.toContain(DEFAULT_SECRET);
  });

  it("the build writes the module from the release value, never into src/, and the module is named as the loader expects", () => {
    const script = readFileSync(join(REPO_ROOT, "scripts", "build.mjs"), "utf8");
    expect(script).toContain("writeDefaultClient(stagedDist, process.env[DEFAULT_CLIENT_SECRET_ENV])");
    expect(script.indexOf("writeDefaultClient(stagedDist")).toBeLessThan(script.indexOf("swapIn(stagedDist, dist)"));
    expect(DEFAULT_CLIENT_SECRET_MODULE).toBe("./default-client-secret.js");
    expect(existsSync(join(REPO_ROOT, "src", MODULE_PATH))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "src", MODULE_PATH.replace(/\.js$/, ".ts")))).toBe(false);
  });
});

describe("google-calendar default client: the loader", () => {
  it("a missing module, a module that does not load, or one with no usable value is no default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-default-client-"));
    const broken = join(dir, "broken.js");
    writeFileSync(broken, "export const = ;\n");
    const empty = join(dir, "empty.js");
    writeFileSync(empty, "export const DEFAULT_GOOGLE_CLIENT_SECRET = '';\n");
    const wrong = join(dir, "wrong.js");
    writeFileSync(wrong, "export const OTHER = 'x';\n");
    for (const path of [join(dir, "absent.js"), broken, empty, wrong]) {
      expect(await loadDefaultClient({ clientId: DEFAULT_ID, moduleUrl: pathToFileURL(path).href })).toBeNull();
    }
    // In src/ the generated module never exists: the plugin's own call finds no default and does not throw.
    expect(await loadDefaultClient({ clientId: DEFAULT_ID })).toBeNull();
  });

  it("with no client ID there is no default, even with a module", async () => {
    const b = await stagedBuild(DEFAULT_SECRET);
    expect(await loadDefaultClient({ clientId: "", moduleUrl: pathToFileURL(b.written!).href })).toBeNull();
    expect(typeof DEFAULT_GOOGLE_CLIENT_ID).toBe("string");
  });
});

describe("google-calendar default client: Connect", () => {
  it("with no default, a secret file without the client asks for both values as before", async () => {
    const google = new FakeGoogle();
    const r = run({});
    await googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => null }).connect(r.ctx);
    expect(r.asked).toEqual(["   Paste GOOGLE_CLIENT_ID (hidden): ", "   Paste GOOGLE_CLIENT_SECRET (hidden): "]);
    expect([...r.stored[0]!]).toEqual([["GOOGLE_CLIENT_ID", OWN_ID], ["GOOGLE_CLIENT_SECRET", OWN_SECRET], ["GOOGLE_REFRESH_TOKEN", REFRESH]]);
  });

  it("with a default and neither client value stored, asks nothing, signs in with the default ID and stores only the refresh token", async () => {
    const google = new FakeGoogle();
    const r = run({});
    await googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => fakeDefault() }).connect(r.ctx);
    expect(r.asked).toEqual([]);
    expect(new URL(r.urls[0]!).searchParams.get("client_id")).toBe(DEFAULT_ID);
    const grant = google.bodies.find((b) => b.get("grant_type") === "authorization_code")!;
    expect(grant.get("client_id")).toBe(DEFAULT_ID);
    expect(grant.get("client_secret")).toBe(DEFAULT_SECRET);
    expect([...r.stored[0]!]).toEqual([["GOOGLE_REFRESH_TOKEN", REFRESH]]);
    // The secret appears in no printed line, URL or stored value.
    expect(everything(r, google)).not.toContain(DEFAULT_SECRET);
  });

  it("a secret file holding both client values keeps using them over the default", async () => {
    const google = new FakeGoogle();
    const r = run({ GOOGLE_CLIENT_ID: OWN_ID, GOOGLE_CLIENT_SECRET: OWN_SECRET });
    let loaded = 0;
    await googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => (loaded++, fakeDefault()) }).connect(r.ctx);
    expect(loaded).toBe(0);
    expect(r.asked).toEqual([]);
    expect(new URL(r.urls[0]!).searchParams.get("client_id")).toBe(OWN_ID);
    expect(google.bodies[0]!.get("client_secret")).toBe(OWN_SECRET);
    expect([...r.stored[0]!].map(([n]) => n)).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
  });

  it("a secret file holding one client value asks for the other, never mixing in the default", async () => {
    const google = new FakeGoogle();
    const r = run({ GOOGLE_CLIENT_ID: OWN_ID });
    await googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => fakeDefault() }).connect(r.ctx);
    expect(r.asked).toEqual(["   Paste GOOGLE_CLIENT_SECRET (hidden): "]);
    expect(new URL(r.urls[0]!).searchParams.get("client_id")).toBe(OWN_ID);
  });

  it("a failed sign-in with the default throws an error that never quotes the secret", async () => {
    const google = new FakeGoogle();
    const r = run({});
    r.ctx.openBrowser = async (url) => {
      r.urls.push(url);
      const u = new URL(url);
      await fetch(`${u.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: CODE, state: "wrong" })}`).then((x) => x.text());
    };
    const err = await googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => fakeDefault() })
      .connect(r.ctx)
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/state did not match/);
    expect(`${err?.message} ${err?.stack} ${everything(r, google)}`).not.toContain(DEFAULT_SECRET);
    expect(r.stored).toEqual([]);
  });
});

describe("google-calendar default client: the token refresh", () => {
  const window = { from: "2026-11-13T00:00:00.000Z", to: "2026-12-14T00:00:00.000Z" };
  const source = (google: FakeGoogle, file: Partial<Record<Name, string>>, defaultClient: () => Promise<DefaultClient | null>) =>
    new GoogleCalendarSource<Name>({
      http: google.client,
      now: () => new Date("2026-11-14T12:00:00.000Z"),
      secrets: { get: async (n) => (file[n] ? { reveal: () => file[n]! } : null) },
      names: NAMES,
      calendarIds: [],
      defaultClient,
    });

  it("with only the refresh token stored, refreshes with the default client", async () => {
    const google = new FakeGoogle();
    await source(google, { GOOGLE_REFRESH_TOKEN: REFRESH }, async () => fakeDefault()).events(window);
    expect(google.bodies[0]!.get("client_id")).toBe(DEFAULT_ID);
    expect(google.bodies[0]!.get("client_secret")).toBe(DEFAULT_SECRET);
  });

  it("a stored client wins over the default", async () => {
    const google = new FakeGoogle();
    await source(google, { GOOGLE_REFRESH_TOKEN: REFRESH, GOOGLE_CLIENT_ID: OWN_ID, GOOGLE_CLIENT_SECRET: OWN_SECRET }, async () => fakeDefault()).events(window);
    expect(google.bodies[0]!.get("client_id")).toBe(OWN_ID);
  });

  it("with no default and no client, the sync fails naming the missing secret, not a value", async () => {
    const google = new FakeGoogle();
    await expect(source(google, { GOOGLE_REFRESH_TOKEN: REFRESH }, async () => null).events(window)).rejects.toThrow(/GOOGLE_CLIENT_ID is not set/);
    expect(google.bodies).toEqual([]);
  });

  it("a refused refresh with the default fails with an error that never quotes the secret (what the store and the dashboard keep)", async () => {
    const google = new FakeGoogle();
    google.refreshStatus = 401;
    const err = await source(google, { GOOGLE_REFRESH_TOKEN: REFRESH }, async () => fakeDefault())
      .events(window)
      .then(() => null, (e: Error) => e);
    expect(err?.message).toBe("google-calendar: token refresh failed (HTTP 401)");
    expect(`${err?.message} ${err?.stack}`).not.toContain(DEFAULT_SECRET);
  });
});
