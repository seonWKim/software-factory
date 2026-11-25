// POST /api/v1/evals/write op `version.settle` (src/ui/evals-api.ts, design 07-self-improvement and 09-dashboard-evals):
// the dashboard's settle of one named held skill version goes through the store method of the bare CLI `factory approve`
// and `factory reject` (settleSkillVersionGate, through settleHeldSkillVersion there and settleSkillVersion here), dismisses
// the version's alarm, and refuses a version that is not held in plain words, writing nothing. GET /api/v1/evals lists
// the held version with the cases that fell and its alarm.

import { describe, expect, it, vi } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { settleHeldSkillVersion } from "../src/core/commands.js";
import { heldAlertKey } from "../src/core/skill-eval-gate.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { EVALS_LIST_PATH, EVALS_WRITE_PATH, type UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, cleanScanner, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:alice" as UserId;
const REF = "sr_review";
const SKILL = "skills/review/SKILL.md";
const DAY_MS = 86_400_000;

/** A store with version 1 of REF (from before the gate: current) and version 2 held by its gate run, with its alarm. */
async function heldStore(): Promise<SqlFactoryStore> {
  const { store } = await newStore(new FakeClock("2026-11-26T08:00:00.000Z"));
  await store.claimOwner(OWNER);
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "Review", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "spot the missing test", expected: ["names it"] });
  await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: { not: "text" }, expected: ["names it"] });
  await store.db.run("INSERT INTO ext_skill_versions (ref_id, version, folder_hash, text, source, created_at) VALUES (?, 1, 'h1', 'old', 'claude', 't')", [REF]);
  await store.recordSkillVersion({ ref_id: REF, folder_hash: "h2", text: "new", source: "claude" });
  await store.startSkillEvalRun({ id: "gate1", suite_id: "s1", created_by: OWNER, skill_version: "h2" });
  await store.takeSkillVersionGate({ ref_id: REF, version: 2, lease_token: "t1", now: "2026-11-26T08:00:00.000Z" as Timestamp, lease_until: "2026-11-26T08:30:00.000Z" as Timestamp });
  await store.finishSkillVersionGate({
    ref_id: REF, version: 2, lease_token: "t1", state: "held", run_id: "gate1",
    detail: { reason: "dropped", pass_rate: 0.5, model_class: "standard", current: { version: 1, run_id: "base", pass_rate: 0.9 }, fell: ["c1", "c2"] },
  });
  await store.recordAlert({ pattern: "skill_version_gate", pattern_key: heldAlertKey(REF, 2), error_code: "pass_rate_drop", count: 2, detail: `${SKILL} version 2 is held` }, DAY_MS);
  return store;
}

async function setup() {
  const store = await heldStore();
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => OWNER,
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: silent,
  };
  const evals = { authoring: {}, tryCase: async () => ({ refused: "unused" }), source: {} } as unknown as UiEvals;
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const d = { store, clock, scanner: cleanScanner, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const settle = vi.spyOn(store, "settleSkillVersionGate");
  const write = async (body: unknown) => {
    const r = await respond(d, { method: "POST", url: EVALS_WRITE_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const list = async () => JSON.parse((await respond(d, { method: "GET", url: EVALS_LIST_PATH, host: HOST })).body) as { skills: string[]; held: Record<string, unknown>[] };
  const openAlert = async () => (await store.listAlerts({ limit: 10 })).find((a) => a.pattern_key === heldAlertKey(REF, 2) && (a.dismissed_at === undefined || a.dismissed_at < a.created_at));
  return { store, write, list, settle, openAlert };
}

/** The gate row and current version after the bare CLI command, on a twin store. */
async function afterCli(command: "approve" | "reject") {
  const store = await heldStore();
  await settleHeldSkillVersion(store, command, OWNER);
  return { gate: await store.getSkillVersionGate(REF, 2), current: (await store.currentSkillVersion(REF))?.version };
}

describe("GET /api/v1/evals: the held versions", () => {
  it("lists the held version with its skill, pass rates, the cases that fell (text inputs only) and its open alarm", async () => {
    const s = await setup();
    const alert = await s.openAlert();
    const { held } = await s.list();
    const mine = held.find((h) => h.ref_id === REF && h.version === 2);
    expect(mine).toEqual({
      ref_id: REF, version: 2, skill: SKILL, pass_rate: 0.5, before: 0.9, current_version: 1,
      fell: [{ case_id: "c1", input: "spot the missing test" }, { case_id: "c2", input: null }], alert_id: alert!.id,
    });
  });
});

describe("POST /api/v1/evals/write version.settle", () => {
  it("approve settles the held version through settleSkillVersionGate with passed, as the bare CLI approve does, and clears its alarm", async () => {
    const s = await setup();
    const r = await s.write({ op: "version.settle", ref: REF, version: 2, decision: "approve" });
    expect(r).toEqual({ status: 200, value: { op: "version.settle", ref: REF, version: 2, decision: "approve", state: "passed" } });
    expect(s.settle).toHaveBeenCalledWith(REF, 2, "passed", OWNER);
    const cli = await afterCli("approve");
    expect(await s.store.getSkillVersionGate(REF, 2)).toMatchObject({ state: cli.gate!.state, detail: cli.gate!.detail });
    expect((await s.store.currentSkillVersion(REF))?.version).toBe(cli.current);
    expect(cli.current).toBe(2);
    expect(await s.openAlert()).toBeUndefined();
    expect((await s.list()).held.some((h) => h.ref_id === REF && h.version === 2)).toBe(false);
  });

  it("reject settles the held version through settleSkillVersionGate with rejected, as the bare CLI reject does, and clears its alarm", async () => {
    const s = await setup();
    const r = await s.write({ op: "version.settle", ref: REF, version: 2, decision: "reject" });
    expect(r).toEqual({ status: 200, value: { op: "version.settle", ref: REF, version: 2, decision: "reject", state: "rejected" } });
    expect(s.settle).toHaveBeenCalledWith(REF, 2, "rejected", OWNER);
    const cli = await afterCli("reject");
    expect(await s.store.getSkillVersionGate(REF, 2)).toMatchObject({ state: cli.gate!.state, detail: cli.gate!.detail });
    expect((await s.store.currentSkillVersion(REF))?.version).toBe(cli.current);
    expect(cli.current).toBe(1);
    expect(await s.openAlert()).toBeUndefined();
  });

  it("refuses a version that is not held with a plain message and changes nothing", async () => {
    const s = await setup();
    const tables = () => Promise.all(["controller_skill_version_gates", "controller_alert_patterns", "ext_skill_versions"].map((t) => s.store.db.all(`SELECT * FROM ${t}`)));
    const before = await tables();
    for (const body of [{ ref: REF, version: 1 }, { ref: REF, version: 9 }, { ref: "sr_other", version: 2 }]) {
      const r = await s.write({ op: "version.settle", ...body, decision: "approve" });
      expect(r.status).toBe(409);
      expect(r.value.error).toBe(`Version ${body.version} of this skill is not waiting for a decision, so nothing was changed.`);
    }
    expect(s.settle).not.toHaveBeenCalled();
    expect(await tables()).toEqual(before);
    // Settled once, the same version is refused the second time, and nothing more is written.
    await s.write({ op: "version.settle", ref: REF, version: 2, decision: "reject" });
    const settled = await tables();
    const again = await s.write({ op: "version.settle", ref: REF, version: 2, decision: "approve" });
    expect(again.status).toBe(409);
    expect(await tables()).toEqual(settled);
  });

  it("refuses a body without a ref, a whole version or a decision with a 400", async () => {
    const s = await setup();
    expect((await s.write({ op: "version.settle", version: 2, decision: "approve" })).status).toBe(400);
    expect((await s.write({ op: "version.settle", ref: REF, version: "2", decision: "approve" })).status).toBe(400);
    expect((await s.write({ op: "version.settle", ref: REF, version: 2, decision: "maybe" })).status).toBe(400);
    expect(s.settle).not.toHaveBeenCalled();
  });
});
