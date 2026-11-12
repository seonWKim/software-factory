// Claim pauses on the dashboard (design §5 Restarts and §9, issue #291): GET /api/v1/pauses lists the pauses in
// effect; POST /api/v1/pauses/resume ends one behind the settings write's guards (Host, Origin, Content-Type,
// CSRF token) and then the owner check (approve_spec). Every refusal leaves every claim_pauses row as it was.

import { OwnerAuth } from "../src/core/authorize.js";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { RESUMABLE_PAUSES } from "../src/resume-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "github:1" as UserId;
const STRANGER = "github:2" as UserId;

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  warn(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  error(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
}

async function setup(opts: { user?: UserId | null; wired?: boolean } = {}) {
  const clock = new FakeClock();
  const { store: real } = await newStore(clock);
  const at = new Date(clock.now().getTime() + 60_000).toISOString() as Timestamp;
  for (const p of RESUMABLE_PAUSES) await real.pauseClaims(at, p);
  // Counts every endClaimPause, so a refusal can be shown to reach no store write.
  let writes = 0;
  const store = new Proxy(real, {
    get(target, key) {
      if (key === "endClaimPause") return (...a: Parameters<FactoryStore["endClaimPause"]>) => (writes++, target.endClaimPause(...a));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const auth = new OwnerAuth({ store: store, claimer: OWNER });
  const log = new MemLog();
  const pauses: UiPauses = {
    principal: async () => (opts.user === undefined ? OWNER : opts.user),
    authorize: (user_id) => auth.authorize({ user_id, attributes: {} }, "approve_spec", { kind: "project", id: PROJECT_KEY }),
    csrfToken: newCsrfToken(),
    log,
  };
  const d: PauseDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    ...(opts.wired === false ? {} : { pauses }),
  };
  const rows = async () => (await real.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows;
  return { d, real, pauses, log, rows, writes: () => writes };
}

function post(p: UiPauses | undefined, body: unknown, over: Partial<UiRequest> = {}): UiRequest {
  return {
    method: "POST", url: "/api/v1/pauses/resume", host: HOST, origin: ORIGIN, contentType: "application/json",
    csrfToken: p?.csrfToken ?? "x", body: JSON.stringify(body), ...over,
  };
}

const parse = (r: { body: string }) => JSON.parse(r.body);

describe("GET /api/v1/pauses", () => {
  it("lists each pause in effect with when it ends, and the CSRF token", async () => {
    const { d, real, pauses } = await setup();
    const r = await respond(d, { method: "GET", url: "/api/v1/pauses", host: HOST });
    expect(r.status).toBe(200);
    const v = parse(r);
    expect(v.csrf_token).toBe(pauses.csrfToken);
    expect(v.pauses.map((p: { name: string }) => p.name)).toEqual([...RESUMABLE_PAUSES]);
    expect(v.pauses[0].ends_at).toBe(await real.getClaimPause("rate_limit"));
  });

  it("lists nothing once every pause is over", async () => {
    const { d, real } = await setup();
    for (const p of RESUMABLE_PAUSES) await real.endClaimPause(p);
    expect(parse(await respond(d, { method: "GET", url: "/api/v1/pauses", host: HOST })).pauses).toEqual([]);
  });
});

describe("POST /api/v1/pauses/resume", () => {
  it("an owner ends one pause; the log line names the factory user ID", async () => {
    const { d, real, pauses, log } = await setup();
    const r = await respond(d, post(pauses, { name: "forge_auth" }));
    expect(r.status).toBe(200);
    expect(parse(r)).toMatchObject({ name: "forge_auth", ended: true });
    expect(parse(r).pauses.map((p: { name: string }) => p.name)).not.toContain("forge_auth");
    expect(await real.getClaimPause("forge_auth")).toBeNull();
    expect(await real.getClaimPause("rate_limit")).not.toBeNull();
    expect(log.lines).toEqual([{ msg: "claim pause ended", fields: { pause: "forge_auth", actor: OWNER, ended: true } }]);
    // Again: nothing in effect, still 200.
    expect(parse(await respond(d, post(pauses, { name: "forge_auth" })))).toMatchObject({ ended: false });
  });

  it("refuses a principal without the write role with 403, and no row changes", async () => {
    const { d, pauses, rows, writes, log } = await setup({ user: STRANGER });
    const before = await rows();
    const r = await respond(d, post(pauses, { name: "rate_limit" }));
    expect(r.status).toBe(403);
    expect(parse(r).error).toContain("approve_spec");
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
    expect(log.lines).toEqual([]);
  });

  it("refuses with 403 when no factory user acts from the page", async () => {
    const { d, pauses, rows, writes } = await setup({ user: null });
    const before = await rows();
    expect((await respond(d, post(pauses, { name: "rate_limit" }))).status).toBe(403);
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
  });

  it("refuses a bad Host, Origin, Content-Type or CSRF token before any store write", async () => {
    const { d, pauses, rows, writes } = await setup();
    const before = await rows();
    const body = { name: "rate_limit" };
    const cases: [Partial<UiRequest>, number][] = [
      [{ host: "evil.example" }, 403],
      [{ host: undefined }, 403],
      [{ origin: "http://evil.example" }, 403],
      [{ origin: undefined }, 403],
      [{ contentType: "text/plain" }, 415],
      [{ contentType: undefined }, 415],
      [{ csrfToken: "stale" }, 403],
      [{ csrfToken: undefined }, 403],
      [{ bodyTooLarge: true }, 413],
      [{ body: "not json" }, 400],
    ];
    for (const [over, status] of cases) {
      expect((await respond(d, post(pauses, body, over))).status, JSON.stringify(over)).toBe(status);
    }
    expect((await respond(d, post(pauses, { name: "model_stall_since" }))).status).toBe(400);
    expect((await respond(d, post(pauses, { name: "nope" }))).status).toBe(400);
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
  });

  it("is a 405 when the pause routes are not wired", async () => {
    const { d, rows } = await setup({ wired: false });
    const before = await rows();
    expect((await respond(d, post(undefined, { name: "rate_limit" }))).status).toBe(405);
    expect(await rows()).toEqual(before);
  });
});
