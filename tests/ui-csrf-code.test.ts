import { describe, expect, it } from "vitest";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import type { UserId } from "../src/core/types.js";
import { cleanScanner, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// The stale-token 403 carries code "stale_csrf" (design 09-dashboard-app), so the page's postJson retries it once
// with a fresh token without matching the message; every other 403 (the origin refusal) carries no code.

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const TOKEN = newCsrfToken();
const MESSAGE = "Missing or stale x-csrf-token; reload the page.";

async function deps(): Promise<ApiDeps> {
  const { store, clock } = await newStore();
  return {
    store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: "local:me" as UserId, source: "environment", token: TOKEN },
    // Only the token is read before the refusal.
    settings: { csrfToken: TOKEN } as UiSettings,
    // The registry's writes (tasks.create) take the pauses token: in a served page the same per-process token.
    pauses: { principal: async () => "local:me" as UserId, authorize: async () => ({ allow: true }), csrfToken: TOKEN, log: silent },
  };
}

/**
 * A write route of each kind: the settings write, a task write (both writePost), a registry capability (tasks.create)
 * and the item commands route (commandsPost).
 */
const ROUTES = ["/api/v1/settings", "/api/v1/tasks/done", "/api/v1/tasks", "/api/v1/items/wi_1/commands"];

const post = async (url: string, over: { origin?: string; csrf?: string | undefined }) => {
  const r = await respond(await deps(), {
    method: "POST", url, host: HOST, origin: over.origin ?? ORIGIN, contentType: "application/json",
    csrfToken: "csrf" in over ? over.csrf : TOKEN, body: "{}",
  });
  return { status: r.status, body: JSON.parse(r.body) as { error?: string; code?: string } };
};

describe("the stale-token 403's code", () => {
  for (const url of ROUTES) {
    it(`${url}: a missing or stale token is 403 with code "stale_csrf" and the unchanged message`, async () => {
      for (const csrf of [undefined, "", newCsrfToken()]) {
        const r = await post(url, { csrf });
        expect(r.status, String(csrf)).toBe(403);
        expect(r.body).toEqual({ error: MESSAGE, code: "stale_csrf" });
      }
    });

    it(`${url}: the origin refusal is 403 with no code`, async () => {
      const r = await post(url, { origin: "http://evil.example" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("Origin must be this page's own origin.");
      expect(r.body).not.toHaveProperty("code");
    });
  }
});
