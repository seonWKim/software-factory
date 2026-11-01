import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clock } from "../src/interfaces/clock.js";
import { type SecretStore, secretName } from "../src/interfaces/secret-store.js";
import { AppCredentials } from "../src/impl/github/app-credentials.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";

// A throwaway key made at run time: no key text is ever written into the repository.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dir = mkdtempSync(join(tmpdir(), "sf-app-"));
const keyFile = join(dir, "github-app.pem");
writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));

const secrets = (appId: string | null): SecretStore => ({
  get: async (n) => (appId !== null && n === secretName("GITHUB_APP_ID") ? new OpaqueSecret(n, appId) : null),
  valuesForScan: async () => [],
});

class TestClock implements Clock {
  constructor(public t: number) {}
  now() {
    return new Date(this.t);
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

function fakeGitHub(expiresIn = 3_600_000, clock?: TestClock) {
  const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method!, url, auth: headers.Authorization!, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith("/repos/o/r/installation")) return Response.json({ id: 77 });
    if (url.endsWith("/app/installations/77/access_tokens")) {
      n++;
      return Response.json({ token: `ghs_token${n}`, expires_at: new Date((clock?.t ?? 0) + expiresIn).toISOString(), permissions: { contents: "write" } }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("AppCredentials (plugins.github_auth: app)", () => {
  it("signs an RS256 JWT with the App ID and exchanges it for a token limited to this repository", async () => {
    const clock = new TestClock(Date.parse("2026-11-01T00:00:00Z"));
    const gh = fakeGitHub(3_600_000, clock);
    const c = new AppCredentials({ secrets: secrets("12345"), keyFile, repo: { owner: "o", name: "r" }, clock, baseUrl: "https://gh.test", fetch: gh.fetchFn });
    const t = await c.token();
    expect(t!.reveal()).toBe("ghs_token1");
    expect(String(t)).not.toContain("ghs_");
    expect(gh.calls.map((x) => [x.method, x.url])).toEqual([
      ["GET", "https://gh.test/repos/o/r/installation"],
      ["POST", "https://gh.test/app/installations/77/access_tokens"],
    ]);
    expect(gh.calls[1]!.body).toEqual({ repositories: ["r"] });
    expect(c.grant()).toEqual({ expires_at: new Date(clock.t + 3_600_000), permissions: { contents: "write" } });
    const jwt = gh.calls[0]!.auth.replace("Bearer ", "");
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const now = clock.t / 1000;
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBeLessThan(now);
    expect(claims.exp - now).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig!, "base64url")).toBe(true);
  });

  it("reuses the token until five minutes before it expires, and shares one mint between concurrent callers", async () => {
    const clock = new TestClock(0);
    const gh = fakeGitHub(3_600_000, clock);
    const c = new AppCredentials({ secrets: secrets("1"), keyFile, repo: { owner: "o", name: "r" }, clock, baseUrl: "https://gh.test", fetch: gh.fetchFn });
    const [a, b] = await Promise.all([c.token(), c.token()]);
    expect([a!.reveal(), b!.reveal()]).toEqual(["ghs_token1", "ghs_token1"]);
    clock.t = 3_600_000 - 5 * 60_000 - 1;
    expect((await c.token())!.reveal()).toBe("ghs_token1");
    clock.t = 3_600_000 - 5 * 60_000;
    expect((await c.token())!.reveal()).toBe("ghs_token2");
  });

  it("is null without GITHUB_APP_ID, and names the key file when it cannot be read", async () => {
    const gh = fakeGitHub();
    const base = { repo: { owner: "o", name: "r" }, clock: new TestClock(0), baseUrl: "https://gh.test", fetch: gh.fetchFn };
    expect(await new AppCredentials({ ...base, secrets: secrets(null), keyFile }).token()).toBeNull();
    const missing = join(dir, "nope.pem");
    await expect(new AppCredentials({ ...base, secrets: secrets("1"), keyFile: missing }).token()).rejects.toThrow(missing);
    expect(gh.calls).toEqual([]);
  });
});
