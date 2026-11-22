// The dashboard's Add model credential dialog (design 09-status-page, Needs you): GET /api/v1/model-credential names
// the declared secrets; POST writes the pasted value to the secret store behind the write routes' guards and the owner
// check, then ends the model_credential pause so Needs you clears. Write-only: no response or log line carries the
// value. The secret store is an in-memory fake behind the dialog's `save`; the clock is a FakeClock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import { MODEL_CREDENTIAL, MODEL_CREDENTIAL_UNTIL } from "../src/core/policy.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { HealthMonitor } from "../src/ui/health.js";
import { MODEL_CREDENTIAL_PATH } from "../src/ui/model-credential.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:owner@example.com" as UserId;
const OTHER = "local:other@example.com" as UserId;
const OAUTH = secretName("CLAUDE_CODE_OAUTH_TOKEN");
const API_KEY = secretName("ANTHROPIC_API_KEY");
/** A secret-like value built from parts, so no literal credential sits in the repository. */
const VALUE = ["sk", "ant", "oat01", "q".repeat(24)].join("-");

const consoleLines: string[] = [];
beforeEach(() => {
  consoleLines.length = 0;
  for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

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

/** The owner's page over a store with the model_credential pause in effect; `as` is who the page acts as. */
async function page(o: { as?: UserId; save?: (v: ReadonlyMap<string, string>) => Promise<void> } = {}) {
  const clock = new FakeClock("2026-11-22T09:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  await store.pauseClaims(MODEL_CREDENTIAL_UNTIL, MODEL_CREDENTIAL);
  const saved = new Map<string, string>(); // the fake secret store
  const settings: UiSettings = {
    base: { file: {}, layers: { defaults: {}, projects: {} } }, repo: { owner: "o", name: "r" }, actor: OWNER, resolveProject: async () => null, csrfToken: newCsrfToken(),
    modelCredential: {
      secrets: [OAUTH, API_KEY],
      save: o.save ?? (async (values) => void values.forEach((v, k) => saved.set(k, v))),
    },
  };
  const log = new MemLog();
  const pauses: UiPauses = { principal: async () => o.as ?? OWNER, authorize: async () => ({ allow: true }), csrfToken: settings.csrfToken, log };
  const d: ApiDeps = {
    store, clock, lease_ms: 300_000, settings, pauses,
    // The scanner knows no value: one in a response would show, not be withheld.
    scanner: new PatternEgressScanner(async () => []),
    health: new HealthMonitor(async () => [], clock),
  };
  const bodies: string[] = [];
  const parsed = (r: { status: number; body: string }) => (bodies.push(r.body), { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> });
  return {
    store, saved, log, bodies, settings,
    get: async (path: string) => parsed(await respond(d, { method: "GET", url: path, host: HOST })),
    post: async (body: unknown, over: Partial<UiRequest> = {}) =>
      parsed(await respond(d, { method: "POST", url: MODEL_CREDENTIAL_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: settings.csrfToken, body: JSON.stringify(body), ...over })),
    codes: async () => ((await parsed(await respond(d, { method: "GET", url: "/api/v1/overview", host: HOST }))).value.system_actions as { code: string }[]).map((a) => a.code),
  };
}

type Page = Awaited<ReturnType<typeof page>>;

/** No response body, log line or console line carries the pasted value. */
function expectNoValue(p: Page) {
  for (const text of [...p.bodies, ...p.log.lines, ...consoleLines]) expect(text).not.toContain(VALUE);
}

describe("Add model credential (design 09-status-page)", () => {
  it("GET names the declared secrets and the page's token, and no value", async () => {
    const p = await page();
    await p.post({ values: { [OAUTH]: VALUE } });
    const r = await p.get(MODEL_CREDENTIAL_PATH);
    expect(r).toEqual({ status: 200, value: { secrets: [OAUTH, API_KEY], csrf_token: p.settings.csrfToken } });
    expectNoValue(p);
  });

  // Bug: the only way to add the credential is `npm run setup` in a terminal; the dashboard says one is missing and stops there.
  // Bug: the write ends the pause itself, and a worker tick before its secret store reads the file again starts it
  // again (the end-to-end race is in model-credential-setup.test.ts); the first tick that sees the credential ends it.
  it("POST writes the value under the declared name and leaves the pause to the workers; no answer or log carries the value", async () => {
    const p = await page();
    expect(await p.codes()).toContain("model_credential");
    const r = await p.post({ values: { [OAUTH]: `  ${VALUE}\n`, [API_KEY]: "" } });
    expect(r).toEqual({ status: 200, value: { saved: [OAUTH] } });
    expect([...p.saved]).toEqual([[OAUTH, VALUE]]);
    expect(await p.store.getClaimPause(MODEL_CREDENTIAL)).not.toBeNull();
    expect(p.log.lines.some((l) => l.startsWith("model credential saved") && l.includes(OAUTH))).toBe(true);
    expectNoValue(p);
  });

  it("refuses a non-owner before any write: nothing saved, the pause stays", async () => {
    const p = await page({ as: OTHER });
    const r = await p.post({ values: { [OAUTH]: VALUE } });
    expect(r.status).toBe(403);
    expect(String(r.value.error)).toMatch(/Only the owner adds a model credential/);
    expect(p.saved.size).toBe(0);
    expect(await p.store.getClaimPause(MODEL_CREDENTIAL)).not.toBeNull();
    expectNoValue(p);
  });

  it("refuses a request without the CSRF token, or with another one, before any write", async () => {
    const p = await page();
    for (const csrfToken of [undefined, "not-the-token"]) {
      const r = await p.post({ values: { [OAUTH]: VALUE } }, { csrfToken });
      expect(r.status).toBe(403);
      expect(r.value.code).toBe("stale_csrf");
    }
    expect((await p.post({ values: { [OAUTH]: VALUE } }, { origin: "http://evil.example" })).status).toBe(403);
    expect(p.saved.size).toBe(0);
    expect(await p.store.getClaimPause(MODEL_CREDENTIAL)).not.toBeNull();
  });

  it("refuses a name the runner does not declare, no value, a value with spaces, and other fields; nothing saved", async () => {
    const p = await page();
    for (const body of [{ values: { GITHUB_TOKEN: VALUE } }, { values: { [OAUTH]: " " } }, { values: {} }, { values: { [OAUTH]: `a ${VALUE}` } }, { values: { [OAUTH]: VALUE }, show: true }, []]) {
      expect((await p.post(body)).status).toBe(400);
    }
    expect(p.saved.size).toBe(0);
    expect(await p.store.getClaimPause(MODEL_CREDENTIAL)).not.toBeNull();
    expectNoValue(p);
  });

  it("a failed write answers 422 naming the step, keeps the pause, and carries no value", async () => {
    const p = await page({ save: async () => { throw new Error("cannot write the secret file: EACCES"); } });
    const r = await p.post({ values: { [OAUTH]: VALUE } });
    expect(r).toEqual({ status: 422, value: expect.objectContaining({ error: expect.stringContaining("EACCES") }) });
    expect(await p.store.getClaimPause(MODEL_CREDENTIAL)).not.toBeNull();
    expectNoValue(p);
  });

  it("with no dialog wired (no runner reads a model credential), GET is a 404 and POST a 405", async () => {
    const p = await page();
    delete p.settings.modelCredential;
    expect((await p.get(MODEL_CREDENTIAL_PATH)).status).toBe(404);
    expect((await p.post({ values: { [OAUTH]: VALUE } })).status).toBe(405);
  });
});
