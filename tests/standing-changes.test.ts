// Standing-rule changes from the Rules page (design 05-standing-approvals, 2026-11-22): POST /api/v1/standing adds
// (turns spec-t1 on, creating its row), pauses, edits (the global threshold) and removes (deletes the row) the rule,
// each behind the owner check (approve_spec), and every change writes one change record with the actor's user ID.
// GET /api/v1/standing carries `waiting`, the items waiting now that the rule would approve (the dialogs' preview).
// `/standing accept|decline` writes the same row and a change record too. Fakes and an in-memory store only.

import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { parseTriage } from "../src/core/outputs.js";
import type { LogFields, Logger } from "../src/core/log.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { Tier, UserId, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";
import { LEASE, enqueue, make } from "./ui-api-fixtures.js";

const HOST = "127.0.0.1:4310";
const OWNER = "github:1" as UserId;
const STRANGER = "github:2" as UserId;

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  warn() {}
  error() {}
}

async function setup(opts: { user?: UserId; settings?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const auth = new OwnerAuth(store);
  const log = new MemLog();
  const pauses: UiPauses = {
    principal: async () => opts.user ?? OWNER,
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT_KEY }),
    csrfToken: newCsrfToken(),
    log,
  };
  const settings: UiSettings = {
    base: { file: {}, layers: { defaults: {}, projects: {} } },
    repo: { owner: "o", name: "r" },
    actor: "local:me",
    resolveProject: async () => null,
    csrfToken: pauses.csrfToken,
  };
  const d: PauseDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    pauses,
    ...(opts.settings === false ? {} : { settings }),
  };
  const send = async (body: unknown) => {
    const req: UiRequest = {
      method: "POST", url: "/api/v1/standing", host: HOST, origin: `http://${HOST}`, contentType: "application/json",
      csrfToken: pauses.csrfToken, body: JSON.stringify(body),
    };
    const r = await respond(d, req);
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const rule = async () => (await store.listStandingRules()).find((r) => r.gate === "spec" && r.tier === 1);
  const changes = () => store.listStandingRuleChanges();
  return { d, store, clock, log, send, rule, changes };
}

const brief = (c: { action: string; before: unknown; after: unknown; actor: string }) => ({ action: c.action, before: c.before, after: c.after, actor: c.actor });

describe("POST /api/v1/standing: add, pause, edit and remove", () => {
  it("add turns spec-t1 on, creating its row, and records add with no before value and the owner's user ID", async () => {
    const { send, rule, changes } = await setup();
    const r = await send({ rule: "spec-t1", enabled: true });
    expect(r).toMatchObject({ status: 200, body: { changed: true } });
    expect(await rule()).toMatchObject({ enabled: true, set_by: OWNER });
    expect((await changes()).map(brief)).toEqual([{ action: "add", before: null, after: { enabled: true }, actor: OWNER }]);
  });

  it("pause turns it off and records pause; pausing a rule already off writes nothing and answers changed: false", async () => {
    const { send, rule, changes } = await setup();
    await send({ rule: "spec-t1", enabled: true });
    expect((await send({ rule: "spec-t1", enabled: false })).body.changed).toBe(true);
    expect((await rule())?.enabled).toBe(false);
    const after = await changes();
    expect(brief(after.at(-1)!)).toEqual({ action: "pause", before: { enabled: true }, after: { enabled: false }, actor: OWNER });
    const again = await send({ rule: "spec-t1", enabled: false });
    expect(again).toMatchObject({ status: 200, body: { changed: false } });
    expect(await changes()).toEqual(after);
  });

  it("pausing with no stored row writes no row and no record", async () => {
    const { send, rule, changes } = await setup();
    expect((await send({ rule: "spec-t1", enabled: false })).body.changed).toBe(false);
    expect(await rule()).toBeUndefined();
    expect(await changes()).toEqual([]);
  });

  it("remove deletes the row and records remove; removing with no stored row writes nothing and answers changed: false", async () => {
    const { send, rule, changes, log } = await setup();
    const none = await send({ rule: "spec-t1", action: "remove" });
    expect(none).toMatchObject({ status: 200, body: { changed: false } });
    expect(await changes()).toEqual([]);
    await send({ rule: "spec-t1", enabled: true });
    const r = await send({ rule: "spec-t1", action: "remove" });
    expect(r).toMatchObject({ status: 200, body: { changed: true } });
    expect(await rule()).toBeUndefined();
    // The read model lists the rule as off with no stored row again.
    expect(r.body.rules.find((x: { rule: string }) => x.rule === "spec-t1")).toMatchObject({ enabled: false, created_at: null });
    expect(brief((await changes()).at(-1)!)).toEqual({ action: "remove", before: { enabled: true }, after: null, actor: OWNER });
    expect(log.lines.at(-1)).toEqual({ msg: "standing rule removed", fields: { rule: "spec-t1", user_id: OWNER } });
  });

  it("edit sets standing_approvals.threshold through the Settings write and records its before and after values", async () => {
    const { send, store, changes } = await setup();
    const r = await send({ rule: "spec-t1", action: "edit", threshold: 12 });
    expect(r).toMatchObject({ status: 200, body: { changed: true } });
    expect(r.body.rules.find((x: { rule: string }) => x.rule === "spec-t1").threshold).toBe(12);
    expect((await store.listSettingOverrides()).find((o) => o.key === "standing_approvals.threshold")?.value).toBe("12");
    expect((await changes()).map(brief)).toEqual([{ action: "edit", before: { threshold: 10 }, after: { threshold: 12 }, actor: OWNER }]);
    // The rule row is not touched: the threshold is one global key, not a field of the rule.
    expect(await store.listStandingRules()).toEqual([]);
  });

  it("an edit to the threshold in force writes nothing; one the Settings write refuses comes back as its refusal, with no record", async () => {
    const { send, store, changes } = await setup();
    expect((await send({ rule: "spec-t1", action: "edit", threshold: 10 })).body.changed).toBe(false);
    const bad = await send({ rule: "spec-t1", action: "edit", threshold: 0 });
    expect(bad.status).toBe(422);
    expect(await changes()).toEqual([]);
    expect((await store.listSettingOverrides()).filter((o) => o.key === "standing_approvals.threshold")).toEqual([]);
  });

  it("an edit on a page with no settings write is refused, with no record", async () => {
    const { send, changes } = await setup({ settings: false });
    expect((await send({ rule: "spec-t1", action: "edit", threshold: 12 })).status).toBe(422);
    expect(await changes()).toEqual([]);
  });

  it("refuses a malformed remove or edit with 400", async () => {
    const { send, changes } = await setup();
    for (const body of [{ rule: "spec-t1", action: "remove", enabled: true }, { rule: "spec-t1", action: "edit" }, { rule: "spec-t1", action: "edit", threshold: "5" }, { rule: "spec-t2", action: "remove" }]) {
      expect((await send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await changes()).toEqual([]);
  });

  it.each([
    ["add", { rule: "spec-t1", enabled: true }],
    ["pause", { rule: "spec-t1", enabled: false }],
    ["edit", { rule: "spec-t1", action: "edit", threshold: 12 }],
    ["remove", { rule: "spec-t1", action: "remove" }],
  ])("%s by a user without approve_spec is a 403 naming the permission, and nothing is written", async (_name, body) => {
    const { send, store, changes } = await setup({ user: STRANGER });
    // A row to pause or remove, written as the owner.
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: OWNER });
    const before = { rules: await store.listStandingRules(), changes: await changes(), overrides: await store.listSettingOverrides() };
    const r = await send(body);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("needs the approve_spec permission");
    expect({ rules: await store.listStandingRules(), changes: await changes(), overrides: await store.listSettingOverrides() }).toEqual(before);
  });
});

describe("GET /api/v1/standing: the waiting items the rule would approve", () => {
  /** An item whose acknowledged triage run wrote `spec`, then waiting at the spec gate at `tier` with `paths` allowed. */
  async function waiting(store: FactoryStore, n: number, tier: Tier, paths: string[], spec: object = {}): Promise<WorkItem> {
    const it = await make(store, n, `Item ${n}`);
    await enqueue(store, it, "triage", `t:${n}`);
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: { ...triageSpec, tier, allowed_paths: paths, files_to_change: paths, ...spec } } });
    const cur = (await store.getWorkItem(it.id))!;
    const r = await store.transition({
      id: it.id, expected_version: cur.version, actor: system, reason: "triaged", ack_run: run.id,
      patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier, allowed_paths: paths },
    });
    if (!r.ok) throw new Error(r.reason);
    return it;
  }

  const get = async (d: PauseDeps) => JSON.parse((await respond(d, { method: "GET", url: "/api/v1/standing", host: HOST })).body);

  it("is empty when nothing waits", async () => {
    const { d } = await setup();
    expect((await get(d)).waiting).toEqual([]);
  });

  it("lists a tier 1 spec waiting at the gate, and leaves out tier 2, protected paths, a split and a spec that changes no file", async () => {
    const { d, store } = await setup();
    const ok = await waiting(store, 1, 1, ["docs/guide.md"]);
    await waiting(store, 2, 2, ["docs/other.md"]);
    await waiting(store, 3, 1, ["src/controller/units/kernel.ts"]);
    const split = { phases: [1, 2].map((n) => ({ title: `Part ${n}`, problem: `Problem ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`docs/p${n}/`] })) };
    // The split parses as one, so it is left out for being a split.
    expect(parseTriage({ ...triageSpec, tier: 1, allowed_paths: ["docs/split.md"], files_to_change: ["docs/split.md"], ...split }).ok).toBe(true);
    await waiting(store, 4, 1, ["docs/split.md"], split);
    await waiting(store, 5, 1, ["docs/none.md"], { files_to_change: [] });
    expect((await get(d)).waiting).toEqual([{ id: ok.id, title: "Item 1" }]);
  });

  it("leaves out an item that is not waiting at the spec gate", async () => {
    const { d, store } = await setup();
    const it = await waiting(store, 1, 1, ["docs/guide.md"]);
    const cur = (await store.getWorkItem(it.id))!;
    await store.transition({ id: it.id, expected_version: cur.version, actor: system, reason: "x", patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null } });
    expect((await get(d)).waiting).toEqual([]);
  });
});

describe("/standing accept and decline write the same row and a change record", () => {
  it("accept records add and decline records pause, with the commenter's user ID", async () => {
    const cfg: FactoryConfig = config;
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const controller = new ControllerRole({
      store, source, forge: new FakeForge(source), auth: new FakeAuth(), clock, config: cfg,
      settings: new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store }), log: silent, scanner: cleanScanner, repeated_failure_rule: false,
    });
    const src = issueRef(1);
    let comment = 0;
    const send = async (e: Parameters<FakeSource["queue"]["push"]>[0]) => {
      clock.advance(1000);
      source.queue.push(e);
      await controller.tickIntake();
    };
    await send({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    const standing = (args: string) => send({ kind: "standing_requested", source: src, comment_id: String(++comment), requester: alice, args });
    await standing("accept spec-t1");
    await standing("decline spec-t1");
    expect((await store.listStandingRules()).find((r) => r.tier === 1)).toMatchObject({ enabled: false, set_by: OWNER });
    expect((await store.listStandingRuleChanges()).map(brief)).toEqual([
      { action: "add", before: null, after: { enabled: true }, actor: OWNER },
      { action: "pause", before: { enabled: true }, after: { enabled: false }, actor: OWNER },
    ]);
  });
});
