import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_SECRET_MODULE, type GoogleClient, defaultGoogleClient } from "../../src/calendar/plugins/google-calendar/default-client.js";
import { type ConnectCtx, googleCalendarConnect } from "../../src/calendar/plugins/google-calendar/google-calendar-connect.js";
import { CALENDAR_READONLY_SCOPE, type HttpClient, TOKEN_URL } from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";

// The factory's default Google client (docs/plugins/calendar-source.md, Turn on; docs/setup.md, release builds): its
// ID is a constant in source, its secret comes only from the module the release build writes into the staged dist/
// from a build-time value, which is never tracked. No test calls Google: the token endpoint is a fake HTTP client, the
// browser a fake opener that calls the loopback listener the way Google's redirect would. Every client value is fake.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const PLUGIN_DIR = "src/calendar/plugins/google-calendar";
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });

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
const FAKE_DEFAULT: GoogleClient = { id: DEFAULT_ID, secret: DEFAULT_SECRET };

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

/** The loader on a module at `path`, as the plugin's own call imports the one beside it. */
const loadFrom = (path: string, id = DEFAULT_ID) => defaultGoogleClient({ id, load: () => import(pathToFileURL(path).href) });

describe("defaultGoogleClient", () => {
  const injected = (secret: unknown) => async () => ({ DEFAULT_GOOGLE_CLIENT_SECRET: secret });

  it("is the constant ID with the injected secret", async () => {
    expect(await defaultGoogleClient({ id: "id.example", load: injected("s3cr") })).toEqual({ id: "id.example", secret: "s3cr" });
  });

  it("is none when the build injected no secret, an unusable one, or the ID is empty", async () => {
    const missing = async () => {
      throw new Error("Cannot find module");
    };
    for (const load of [missing, injected(undefined), injected(""), injected("has space"), injected(42)]) {
      expect(await defaultGoogleClient({ id: "id.example", load })).toBeNull();
    }
    expect(await defaultGoogleClient({ id: "", load: injected("s3cr") })).toBeNull();
  });

  it("a missing module or one that does not load is no default, and does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-default-client-"));
    const broken = join(dir, "broken.js");
    writeFileSync(broken, "export const = ;\n");
    const wrong = join(dir, "wrong.js");
    writeFileSync(wrong, "export const OTHER = 'x';\n");
    for (const path of [join(dir, "absent.js"), broken, wrong]) expect(await loadFrom(path)).toBeNull();
  });

  it("the ID is a named constant, and the default loader reads the injected module beside it", async () => {
    expect(typeof DEFAULT_GOOGLE_CLIENT_ID).toBe("string");
    expect(DEFAULT_SECRET_MODULE).toBe("./default-client-secret.js");
    // With no injected module in this checkout, the default loader finds no client and does not throw.
    if (DEFAULT_GOOGLE_CLIENT_ID === "") expect(await defaultGoogleClient()).toBeNull();
  });
});

describe("the release build step", () => {
  it("with no release value writes no module and nothing else", async () => {
    for (const value of [undefined, "", "   "]) {
      const b = await stagedBuild(value);
      expect(b.written).toBeNull();
      expect(files(b.staged)).toEqual([join("calendar", "plugins", "google-calendar", "default-client.js")]);
      expect(readdirSync(b.root)).toEqual(["dist.build-1-1"]);
    }
  });

  it("with a release value writes the module into the staged dist/, mode 600, and nothing outside it; the loader reads it back", async () => {
    const b = await stagedBuild(DEFAULT_SECRET);
    expect(b.written).toBe(join(b.staged, MODULE_PATH));
    expect(files(b.staged).sort()).toEqual([join("calendar", "plugins", "google-calendar", "default-client.js"), MODULE_PATH].sort());
    expect(readdirSync(b.root)).toEqual(["dist.build-1-1"]);
    expect(statSync(b.written!).mode & 0o777).toBe(0o600);
    expect(await loadFrom(b.written!)).toEqual(FAKE_DEFAULT);
    // With no client ID there is no default, even with the module.
    expect(await loadFrom(b.written!, "")).toBeNull();
  });

  it("runs before the swap, from the release value, never into src/, under the name the loader imports", () => {
    const script = readFileSync(join(REPO_ROOT, "scripts", "build.mjs"), "utf8");
    expect(script).toContain("writeDefaultClient(stagedDist, process.env[DEFAULT_CLIENT_SECRET_ENV])");
    expect(script.indexOf("writeDefaultClient(stagedDist")).toBeLessThan(script.indexOf("swapIn(stagedDist, dist)"));
    expect(MODULE_PATH.endsWith(DEFAULT_SECRET_MODULE.slice(2))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src", MODULE_PATH))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "src", MODULE_PATH.replace(/\.js$/, ".ts")))).toBe(false);
  });
});

/** Google's token endpoint, faked. */
class FakeGoogle {
  readonly bodies: URLSearchParams[] = [];
  readonly client: HttpClient = async (url, init) => {
    if (url !== TOKEN_URL) throw new Error(`unexpected call to ${url}`);
    this.bodies.push(new URLSearchParams(init.body));
    const body = { refresh_token: REFRESH, access_token: "fake-access", expires_in: 3600, scope: CALENDAR_READONLY_SCOPE };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

interface Run {
  ctx: ConnectCtx<Name>;
  printed: string[];
  asked: string[];
  urls: string[];
}

/** A connect context over a fake secret file holding `file`; the fake browser answers with a code and `state`. */
function run(file: Partial<Record<Name, string>>, state?: string): Run {
  const r: Run = { printed: [], asked: [], urls: [], ctx: undefined as unknown as ConnectCtx<Name> };
  r.ctx = {
    secretsFile: "/fake/secrets/.env",
    secrets: { get: async (n) => (file[n] ? { reveal: () => file[n]! } : null) },
    ask: { hidden: async (p) => (r.asked.push(p), p.includes("SECRET") ? OWN_SECRET : OWN_ID) },
    print: (line) => void r.printed.push(line),
    openBrowser: async (url) => {
      r.urls.push(url);
      const u = new URL(url);
      await fetch(`${u.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: CODE, state: state ?? u.searchParams.get("state")! })}`).then((x) => x.text());
    },
    storeSecrets: async () => undefined,
    removeSecrets: async () => undefined,
    clock: { sleep: () => new Promise(() => undefined) },
  };
  return r;
}

const connectWith = (google: FakeGoogle, defaultClient: GoogleClient | null) =>
  googleCalendarConnect({ http: google.client, names: NAMES, defaultClient: async () => defaultClient });

describe("Connect with the default client", () => {
  it("with no default, a secret file without the client asks for both values as before", async () => {
    const r = run({});
    await connectWith(new FakeGoogle(), null).connect(r.ctx);
    expect(r.asked).toEqual(["   Paste GOOGLE_CLIENT_ID (hidden): ", "   Paste GOOGLE_CLIENT_SECRET (hidden): "]);
  });

  it("with a default and neither client value stored, asks nothing and signs in with the default ID; the secret is in no printed line or URL", async () => {
    const google = new FakeGoogle();
    const r = run({});
    await connectWith(google, FAKE_DEFAULT).connect(r.ctx);
    expect(r.asked).toEqual([]);
    expect(new URL(r.urls[0]!).searchParams.get("client_id")).toBe(DEFAULT_ID);
    expect(google.bodies[0]!.get("client_secret")).toBe(DEFAULT_SECRET);
    expect(JSON.stringify({ printed: r.printed, urls: r.urls })).not.toContain(DEFAULT_SECRET);
  });

  it("a secret file holding both client values keeps using them over the default", async () => {
    const google = new FakeGoogle();
    const r = run({ GOOGLE_CLIENT_ID: OWN_ID, GOOGLE_CLIENT_SECRET: OWN_SECRET });
    await connectWith(google, FAKE_DEFAULT).connect(r.ctx);
    expect(r.asked).toEqual([]);
    expect(new URL(r.urls[0]!).searchParams.get("client_id")).toBe(OWN_ID);
    expect(google.bodies[0]!.get("client_secret")).toBe(OWN_SECRET);
  });

  it("a failed sign-in with the default throws an error that never quotes the secret", async () => {
    const r = run({}, "wrong");
    const err = await connectWith(new FakeGoogle(), FAKE_DEFAULT)
      .connect(r.ctx)
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/state did not match/);
    expect(`${err?.message} ${err?.stack} ${r.printed.join("\n")}`).not.toContain(DEFAULT_SECRET);
  });
});

describe("no client secret in the repository", () => {
  it("the injected module lives only in the ignored build output, never in the source tree", () => {
    const built = `dist/calendar/plugins/google-calendar/${DEFAULT_SECRET_MODULE.slice(2)}`;
    expect(git("check-ignore", "--no-index", built).trim()).toBe(built);
    expect(git("ls-files", "--", PLUGIN_DIR).split("\n").filter((f) => f.includes("default-client-secret"))).toEqual([]);
  });

  it("no tracked file holds a Google OAuth client secret", () => {
    // Google's client secrets start with this prefix; the pattern is built so this file does not match itself.
    const secret = new RegExp(`${"GOCSPX"}-[A-Za-z0-9_-]{20,}`);
    const flagged = git("ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .filter((f) => {
        try {
          return secret.test(readFileSync(join(REPO_ROOT, f), "latin1"));
        } catch {
          return false; // a tracked file deleted in the working tree
        }
      });
    expect(flagged).toEqual([]);
  });
});
