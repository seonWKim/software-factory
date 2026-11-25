// The routine HTTP API is retired (design 08-schedules): the two /api/v1/routines reads answer 404 and every write is a POST no route takes (the shell's JSON 405, POST_ONLY), through respond(),
// and the removed module and its test are gone. Routines are Check a page schedules, read at /api/v1/schedules.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { POST_ONLY } from "../src/ui/write-routes.js";
import { silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const POSTS = ["add", "edit", "pause", "resume", "delete", "run"];

async function deps() {
  const clock = new FakeClock("2026-11-25T12:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const pauses: UiPauses = { principal: async () => OWNER, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const d: PauseDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses };
  return { d, pauses };
}

describe("the retired routine routes", () => {
  it("answer 404 to the two reads and 405 (no route takes the POST) to every write", async () => {
    const { d, pauses } = await deps();
    for (const url of ["/api/v1/routines", "/api/v1/routines/suggestions", "/api/v1/routines/suggestions?routine=cp_1"]) {
      expect((await respond(d, { method: "GET", url, host: HOST })).status, url).toBe(404);
    }
    for (const verb of POSTS) {
      const r = await respond(d, {
        method: "POST", url: `/api/v1/routines/${verb}`, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify({ id: "cp_1" }),
      });
      expect(r.status, verb).toBe(405);
      expect(JSON.parse(r.body).error).toBe(POST_ONLY);
    }
  });

  it("have no source or test file left, and the schedule API test does not read them", () => {
    expect(existsSync("src/ui/routines-api.ts")).toBe(false);
    expect(existsSync("tests/routines-api.test.ts")).toBe(false);
    expect(readFileSync("tests/schedule-api.test.ts", "utf8")).not.toContain("/api/v1/routines");
  });
});
