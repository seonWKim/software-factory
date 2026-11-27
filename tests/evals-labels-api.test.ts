import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { EVALS_WRITE_PATH, type UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { CLEAN, FLAGGING, HOST, ORIGIN, OWNER, SKILL, evalGet as get, evalSeeded as seeded, tables } from "./ui-api-fixtures.js";

// The owner's labels on the judge (design 06-measurement, judge labels; 09-dashboard-evals, Judge checks):
// POST /api/v1/evals/write op label.set behind the request guards and the approve_spec owner check, and
// GET /api/v1/evals/<skill>/calibration.

const ENC = encodeURIComponent(SKILL);
/** A judged yes/no answer, a deterministic one (never listed) and a rubric answer, as the engine stores them. */
const answers = (yes: string) => [
  { check: yes, answer: "yes", reason: "ok", kind: "yes/no", weight: 1, must: false, value: 1 },
  { check: "contains: hello", answer: "no", reason: "missing", kind: "contains", weight: 1, must: false, value: 0 },
  { check: "Explains why", answer: "no", reason: "thin", kind: "rubric", weight: 1, must: false, value: 0.25, score: 2 },
];

/** seeded() with replays on the newest finished run ("new"), a running run newer than it, and the owner check wired. */
async function labelled(opts: { user?: UserId; scanner?: EgressScanner } = {}) {
  const store = await seeded();
  await store.claimOwner(OWNER);
  await store.recordSkillEvalReplay({ run_id: "new", case_id: "c1", replay: 1, verdict: "pass", detail: { answers: answers("Names a test") } });
  await store.recordSkillEvalReplay({ run_id: "new", case_id: "c2", replay: 1, verdict: "fail", detail: { answers: answers("Says LEAK") } });
  await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", verdict: "pass", detail: { answers: answers("Names a test") } });
  await store.startSkillEvalRun({ id: "busy", suite_id: "s1", created_by: OWNER });
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => opts.user ?? OWNER,
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: silent,
  };
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const evals = { authoring: {}, tryCase: async () => ({ refused: "unused" }), source: {} } as unknown as UiEvals;
  const d = { store, clock, scanner: opts.scanner ?? CLEAN, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const write = async (body: unknown) => {
    const r = await respond(d, { method: "POST", url: EVALS_WRITE_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const calibration = async () => JSON.parse((await respond(d, { method: "GET", url: `/api/v1/evals/${ENC}/calibration`, host: HOST })).body) as Calibration;
  const labels = () => store.db.all("SELECT * FROM controller_skill_eval_labels");
  return { store, write, calibration, labels };
}

interface Calibration {
  labels: number;
  agreement: number | null;
  calibrated: boolean;
  run: string | null;
  checks: { case_id: string; replay: number; check: string; answer: string; label: string | null }[];
}

const LABEL = { op: "label.set", run: "new", case: "c1", replay: 1, check: "Names a test", label: "right" };

describe("POST /api/v1/evals/write: label.set", () => {
  it("stores one label with the page's factory user as owner_id, and a second label on the same check keeps the first", async () => {
    const s = await labelled();
    const r = await s.write(LABEL);
    expect(r).toEqual({ status: 200, value: { op: "label.set", run: "new", case: "c1", replay: 1, check: "Names a test", label: "right" } });
    const again = await s.write({ ...LABEL, label: "wrong" });
    expect(again.value).toMatchObject({ label: "right" });
    const rows = await s.labels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: "new", case_id: "c1", replay: 1, check_text: "Names a test", verdict: "right", owner_id: OWNER });
  });

  it("labels a judged rubric check and a replay stored with no number as replay 0", async () => {
    const s = await labelled();
    expect((await s.write({ ...LABEL, check: "Explains why", label: "wrong" })).status).toBe(200);
    expect((await s.write({ ...LABEL, run: "old", replay: 0 })).status).toBe(200);
    expect((await s.store.listSkillEvalLabels(SKILL)).map((l) => [l.run_id, l.replay, l.check, l.verdict])).toEqual([["new", 1, "Explains why", "wrong"], ["old", 0, "Names a test", "right"]]);
  });

  it.each([
    [{ label: "maybe" }, "label must be right or wrong"],
    [{ label: undefined }, "label must be right or wrong"],
    [{ replay: -1 }, "replay must be a whole number from 0"],
    [{ replay: 1.5 }, "replay must be a whole number from 0"],
    [{ replay: "1" }, "replay must be a whole number from 0"],
    [{ check: " " }, "check must be a non-empty string"],
    [{ run: "" }, "run must be a non-empty string"],
    [{ case: undefined }, "case must be a non-empty string"],
  ])("is a 400 for %o and writes nothing", async (over, error) => {
    const s = await labelled();
    const r = await s.write({ ...LABEL, ...over });
    expect(r.status).toBe(400);
    expect(String(r.value.error)).toContain(error);
    expect(await s.labels()).toEqual([]);
  });

  it.each([
    [{ run: "nope" }, "There is no eval run nope"],
    [{ case: "c9" }, "has no replay in that run"],
    [{ replay: 2 }, "That run has no replay 2"],
    [{ check: "contains: hello" }, "The judge did not answer that check"],
    [{ check: "Never asked" }, "The judge did not answer that check"],
  ])("is a 409 in plain words for %o and writes nothing", async (over, error) => {
    const s = await labelled();
    const r = await s.write({ ...LABEL, ...over });
    expect(r.status).toBe(409);
    expect(String(r.value.error)).toContain(error);
    expect(String(r.value.error)).toContain("nothing was labelled");
    expect(await s.labels()).toEqual([]);
  });

  it("is a 403 without approve_spec, the same owner check as the other evals writes, and writes nothing", async () => {
    const s = await labelled({ user: "local:bob" as UserId });
    const r = await s.write(LABEL);
    expect(r.status).toBe(403);
    expect(String(r.value.error)).toContain("approve_spec");
    expect(await s.labels()).toEqual([]);
  });
});

describe("GET /api/v1/evals/<skill>/calibration", () => {
  it("with no labels: no agreement, not calibrated, and the newest finished run's judged checks unlabelled, writing nothing", async () => {
    const s = await labelled();
    const before = await tables(s.store);
    const c = await s.calibration();
    expect(c).toMatchObject({ labels: 0, agreement: null, calibrated: false, run: "new" });
    expect(c.checks).toEqual([
      { case_id: "c1", replay: 1, check: "Names a test", answer: "yes", reason: "ok", label: null },
      { case_id: "c1", replay: 1, check: "Explains why", answer: "no", reason: "thin", label: null },
      { case_id: "c2", replay: 1, check: "Says LEAK", answer: "yes", reason: "ok", label: null },
      { case_id: "c2", replay: 1, check: "Explains why", answer: "no", reason: "thin", label: null },
    ]);
    expect(await tables(s.store)).toEqual(before);
  });

  it("answers agreement as right labels over all of the skill's labels, judgeCalibrated's verdict, and each check's label", async () => {
    const s = await labelled();
    await s.write(LABEL);
    await s.write({ ...LABEL, check: "Explains why", label: "wrong" });
    await s.write({ ...LABEL, run: "old", replay: 0 });
    const c = await s.calibration();
    expect(c).toMatchObject({ labels: 3, agreement: 2 / 3, calibrated: false });
    expect(c.checks.filter((x) => x.case_id === "c1").map((x) => x.label)).toEqual(["right", "wrong"]);
    for (const check of ["Names a test", "Explains why"]) await s.write({ ...LABEL, case: "c2", check: check === "Names a test" ? "Says LEAK" : check });
    for (const check of ["a", "b"]) await s.store.recordSkillEvalLabel({ run_id: "old", case_id: "c1", replay: 0, check, verdict: "right", owner_id: OWNER });
    expect(await s.calibration()).toMatchObject({ labels: 7, agreement: 6 / 7, calibrated: true });
  });

  it("has no run and no checks when the skill has no finished run", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "busy", suite_id: "s1", created_by: OWNER });
    const r = await get(store, CLEAN, `/api/v1/evals/${ENC}/calibration`);
    expect(r.value).toEqual({ labels: 0, agreement: null, calibrated: false, run: null, checks: [] });
  });

  it("withholds a flagged string", async () => {
    const s = await labelled({ scanner: FLAGGING });
    const c = await s.calibration();
    expect(JSON.stringify(c)).not.toContain("LEAK");
    expect(c.checks.map((x) => x.check)).toContain("[withheld: test_rule]");
  });
});
