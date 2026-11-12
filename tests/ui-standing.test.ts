// Standing approvals on the dashboard (design 05-standing-approvals and §9, issue #300): GET /api/v1/standing lists
// each rule and the pending proposals; POST /api/v1/standing turns a rule on or off behind the settings write's
// guards (Host, Origin, Content-Type, CSRF token) and then the pause route's owner check (approve_spec). Every
// refusal leaves the standing_rules table as it was.

import { OwnerAuth } from "../src/core/authorize.js";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "github:1" as UserId;
const STRANGER = "github:2" as UserId;
// A GitHub token shape the pattern scanner withholds.
const SECRET = `ghp_${"a".repeat(36)}`;

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
  // Counts every putStandingRule, so a refusal can be shown to reach no store write.
  let writes = 0;
  const store = new Proxy(real, {
    get(target, key) {
      if (key === "putStandingRule") return (...a: Parameters<FactoryStore["putStandingRule"]>) => (writes++, target.putStandingRule(...a));
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
  const rows = async () => (await real.listTableRows({ table: "controller_standing_rules", limit: 200 }))!.rows;
  return { d, real, clock, pauses, log, rows, writes: () => writes };
}

function post(p: UiPauses | undefined, body: unknown, over: Partial<UiRequest> = {}): UiRequest {
  return {
    method: "POST", url: "/api/v1/standing", host: HOST, origin: ORIGIN, contentType: "application/json",
    csrfToken: p?.csrfToken ?? "x", body: JSON.stringify(body), ...over,
  };
}

const parse = (r: { body: string }) => JSON.parse(r.body);
const get = async (d: PauseDeps) => parse(await respond(d, { method: "GET", url: "/api/v1/standing", host: HOST }));

describe("GET /api/v1/standing", () => {
  it("lists spec-t1 as off with the default threshold before any rule is stored, with the CSRF token", async () => {
    const { d, pauses } = await setup();
    const v = await get(d);
    expect(v.csrf_token).toBe(pauses.csrfToken);
    const rule = v.rules.find((r: { rule: string }) => r.rule === "spec-t1");
    expect(rule).toMatchObject({ gate: "spec", tier: 1, threshold: 10, enabled: false, set_by: null, created_at: null, last_used_at: null });
    expect(v.proposals).toEqual([]);
  });

  it("shows the stored rule and the effective threshold override", async () => {
    const { d, real, clock } = await setup();
    await real.setSettingOverride({ key: "standing_approvals.threshold", project: "", value: "4", actor: "local:me" });
    const created = clock.now().toISOString();
    await real.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: OWNER });
    const rule = (await get(d)).rules.find((r: { rule: string }) => r.rule === "spec-t1");
    expect(rule).toMatchObject({ threshold: 4, enabled: true, set_by: OWNER, created_at: created });
  });

  it("lists a proposal only while it waits: not after its rule is accepted or declined", async () => {
    const { d, real, clock } = await setup();
    const { proposal } = await real.recordStandingProposal({ gate: "spec", tier: 1, run_length: 10, threshold: 10 });
    const ids = async () => (await get(d)).proposals.map((p: { id: string }) => p.id);
    expect(await ids()).toContain(proposal.id);
    const listed = (await get(d)).proposals.find((p: { id: string }) => p.id === proposal.id);
    expect(listed).toMatchObject({ rule: "spec-t1", run_length: 10, threshold: 10, created_at: proposal.created_at });
    clock.advance(1000);
    await real.putStandingRule({ gate: "spec", tier: 1, enabled: false, set_by: OWNER });
    expect(await ids()).not.toContain(proposal.id);
  });

  it("passes every text value through the Withholder", async () => {
    const { d, real } = await setup();
    await real.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: SECRET as UserId });
    const v = await get(d);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(v.rules.find((r: { rule: string }) => r.rule === "spec-t1").set_by).toMatch(/^\[withheld: /);
  });
});

describe("POST /api/v1/standing", () => {
  it("an owner turns spec-t1 on, then off; set_by is the user ID and each write logs one line", async () => {
    const { d, real, pauses, log } = await setup();
    const on = await respond(d, post(pauses, { rule: "spec-t1", enabled: true }));
    expect(on.status).toBe(200);
    expect(parse(on)).toMatchObject({ changed: true });
    expect(parse(on).rules.find((r: { rule: string }) => r.rule === "spec-t1").enabled).toBe(true);
    expect((await real.listStandingRules()).find((r) => r.tier === 1)).toMatchObject({ enabled: true, set_by: OWNER });
    const off = await respond(d, post(pauses, { rule: "spec-t1", enabled: false }));
    expect(parse(off)).toMatchObject({ changed: true });
    expect((await real.listStandingRules()).find((r) => r.tier === 1)?.enabled).toBe(false);
    expect(log.lines).toEqual([
      { msg: "standing rule on", fields: { rule: "spec-t1", user_id: OWNER } },
      { msg: "standing rule off", fields: { rule: "spec-t1", user_id: OWNER } },
    ]);
  });

  it("off, then on: a fresh GET (the page's reload) shows the last write", async () => {
    const { d, real, pauses } = await setup();
    await real.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: OWNER });
    for (const enabled of [false, true]) expect((await respond(d, post(pauses, { rule: "spec-t1", enabled }))).status).toBe(200);
    expect((await get(d)).rules.find((r: { rule: string }) => r.rule === "spec-t1").enabled).toBe(true);
  });

  it("setting the state the rule already has writes nothing and answers changed: false", async () => {
    const { d, pauses, rows, writes } = await setup();
    // No rule stored is off.
    const first = await respond(d, post(pauses, { rule: "spec-t1", enabled: false }));
    expect(first.status).toBe(200);
    expect(parse(first).changed).toBe(false);
    expect(writes()).toBe(0);
    await respond(d, post(pauses, { rule: "spec-t1", enabled: true }));
    const before = await rows();
    const again = await respond(d, post(pauses, { rule: "spec-t1", enabled: true }));
    expect(again.status).toBe(200);
    expect(parse(again).changed).toBe(false);
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(1);
  });

  it("accepting or declining a pending proposal records the answer and the proposal leaves the list", async () => {
    const { d, real, clock, pauses, log } = await setup();
    const { proposal } = await real.recordStandingProposal({ gate: "spec", tier: 1, run_length: 10, threshold: 10 });
    clock.advance(1000);
    const r = await respond(d, post(pauses, { rule: "spec-t1", enabled: false, proposal: proposal.id }));
    expect(r.status).toBe(200);
    expect(parse(r).changed).toBe(true);
    expect(parse(r).proposals.map((p: { id: string }) => p.id)).not.toContain(proposal.id);
    expect(log.lines.at(-1)).toEqual({ msg: "standing rule off", fields: { rule: "spec-t1", user_id: OWNER, proposal: proposal.id } });
  });

  it("refuses a rule other than spec-t1 with 400, and nothing is written", async () => {
    const { d, pauses, rows, writes } = await setup();
    const before = await rows();
    for (const rule of ["spec-t2", "review-t1", "", 1]) {
      const r = await respond(d, post(pauses, { rule, enabled: true }));
      expect(r.status, String(rule)).toBe(400);
    }
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
  });

  it("refuses a body that is not a rule write with 400, and nothing is written", async () => {
    const { d, pauses, writes } = await setup();
    for (const body of [[], null, "x", { rule: "spec-t1" }, { rule: "spec-t1", enabled: "yes" }, { rule: "spec-t1", enabled: true, extra: 1 }]) {
      expect((await respond(d, post(pauses, body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(writes()).toBe(0);
  });

  it("refuses a proposal that is not stored with 400, and nothing is written", async () => {
    const { d, pauses, rows, writes } = await setup();
    const before = await rows();
    const r = await respond(d, post(pauses, { rule: "spec-t1", enabled: true, proposal: "sp_missing" }));
    expect(r.status).toBe(400);
    expect(parse(r).error).toContain("proposal");
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
  });

  it("refuses a user without approve_spec with 403, and nothing changes", async () => {
    const { d, pauses, rows, writes, log } = await setup({ user: STRANGER });
    const before = await rows();
    const r = await respond(d, post(pauses, { rule: "spec-t1", enabled: true }));
    expect(r.status).toBe(403);
    expect(parse(r).error).toContain("approve_spec");
    expect(await rows()).toEqual(before);
    expect(writes()).toBe(0);
    expect(log.lines).toEqual([]);
  });

  it("refuses with 403 when no factory user acts from the page", async () => {
    const { d, pauses, writes } = await setup({ user: null });
    expect((await respond(d, post(pauses, { rule: "spec-t1", enabled: true }))).status).toBe(403);
    expect(writes()).toBe(0);
  });

  describe("request guards, each before any store write", () => {
    const cases: [string, Partial<UiRequest>, number][] = [
      ["another Host", { host: "evil.example" }, 403],
      ["no Host", { host: undefined }, 403],
      ["another Origin", { origin: "http://evil.example" }, 403],
      ["no Origin", { origin: undefined }, 403],
      ["a Content-Type other than JSON", { contentType: "text/plain" }, 415],
      ["no Content-Type", { contentType: undefined }, 415],
      ["a stale x-csrf-token", { csrfToken: "stale" }, 403],
      ["no x-csrf-token", { csrfToken: undefined }, 403],
      ["a body too large", { bodyTooLarge: true }, 413],
      ["a body that is not JSON", { body: "not json" }, 400],
    ];
    it.each(cases)("refuses %s", async (_name, over, status) => {
      const { d, pauses, rows, writes } = await setup();
      const before = await rows();
      expect((await respond(d, post(pauses, { rule: "spec-t1", enabled: true }, over))).status).toBe(status);
      expect(await rows()).toEqual(before);
      expect(writes()).toBe(0);
    });
  });

  it("is a 405 when the pause routes (the owner check) are not wired", async () => {
    const { d, writes } = await setup({ wired: false });
    expect((await respond(d, post(undefined, { rule: "spec-t1", enabled: true }))).status).toBe(405);
    expect(writes()).toBe(0);
  });
});
