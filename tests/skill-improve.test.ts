// Skill improvement (design 07-self-improvement, src/core/skill-improve.ts): the drop and stall trigger, one draft per
// skill version, the draft prompt's content (dev cases' failed check names only), the dev scratch measurement and its
// gain over the dev replays of the current version's run, the judge calibration gate (no owner labels or agreement below 80%:
// skipped uncalibrated, no day slot), the proposed-or-tried rule (no owner label: tried untrusted),
// the verdicts with the held-out check before a promotion, and the two limits. The store is the real SQLite store; the model, the replay and the skill files are fakes: no test calls a
// model or a remote service.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type SkillImproveWiring, baselineVersion, heldOutVersion, holdSkillDraft, improveSkills, ownerLabelled, promoteSkillDraft, rejectSkillDraft, scratchVersion, skillDraftId, skillTrigger,
} from "../src/core/skill-improve.js";
import { SKILL_IMPROVE_DEFAULTS, type SkillImproveConfig } from "../src/core/skill-improve-config.js";
import type { UserId } from "../src/core/types.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { SkillEvalRun } from "../src/interfaces/skill-eval-store.js";
import type { TacitHandOff } from "../src/interfaces/tacit-ledger.js";
import { systemSource } from "../src/core/improver.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { PROJECT as CONFIG_PROJECT, cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner" as UserId;
const PROJECT = "local:p";
const PROMPT = readFileSync(join(import.meta.dirname, "..", "prompts", "skill-improve.md"), "utf8");
const A = "skills/a";
const B = "skills/b";
const signal = () => new AbortController().signal;

type Store = FactoryStore & { db: { all(q: string, p?: unknown[]): Promise<Record<string, unknown>[]>; run(q: string, p?: unknown[]): Promise<unknown> } };

/** The fake model: answers each call with `answer`, recording the requests. */
function fakeLlm(answer: (req: LLMRequest) => LLMResponse | Promise<LLMResponse> = () => reply("NEW SKILL TEXT")): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return { calls, complete: async (req) => (calls.push(req), answer(req)) };
}
const reply = (text: string, tokens = 100): LLMResponse => ({ text, stop_reason: "end", usage: { input_tokens: tokens / 2, output_tokens: tokens / 2, cost_usd: null } });

/** The held-out scratch runs' pass rates, of the draft text and of the current text (each absent: 1; null: no pass rate), or a throw. */
type HeldOut = { draft?: number | null; current?: number | null; throw?: boolean };

/**
 * In-memory skill files under /repo/skills, a dev scratch run at `scratchRate`, held-out scratch runs at `heldOut`, and
 * a re-run, all stored in `store`.
 */
function fakeWiring(store: Store, clock: FakeClock, o: { config?: Partial<SkillImproveConfig>; scratchRate?: number | null; scratch?: "throw" | "none"; heldOut?: HeldOut } = {}) {
  const files = new Map<string, string>([["/repo/skills/a", "SKILL A"], ["/repo/skills/b", "SKILL B"], ["/repo/other/c", "SKILL C"]]);
  const scratches: Parameters<SkillImproveWiring["scratch"]>[0][] = [];
  const reruns: Parameters<SkillImproveWiring["rerun"]>[0][] = [];
  let n = 0;
  const wiring: SkillImproveWiring = {
    config: { ...SKILL_IMPROVE_DEFAULTS, ...o.config },
    skill_folders: ["/repo/skills"],
    folderOf: (ref) => `/repo/${ref}`,
    prompt: async () => PROMPT,
    readSkill: async (f) => files.get(f) ?? null,
    writeSkill: async (f, text) => void files.set(f, text),
    version: async (f) => (files.has(f) ? `v:${files.get(f)}` : null),
    newId: () => `id${++n}`,
    scratch: async (r) => {
      scratches.push(r);
      if (r.split === "held-out") {
        if (o.heldOut?.throw) throw new Error("model down");
        const rate = r.system_prompt === files.get(`/repo/${r.skill_ref}`) ? o.heldOut?.current : o.heldOut?.draft;
        return run(store, clock, { id: r.run_id, ref: r.skill_ref, version: r.skill_version, rate: rate === undefined ? 1 : rate, model_class: r.model_class });
      }
      if (o.scratch === "throw") throw new Error("sandbox down");
      if (o.scratch === "none") return null;
      return run(store, clock, { id: r.run_id, ref: r.skill_ref, version: r.skill_version, rate: o.scratchRate === undefined ? 1 : o.scratchRate, model_class: r.model_class });
    },
    rerun: async (r) => {
      reruns.push(r);
      return run(store, clock, { id: `rerun${++n}`, ref: r.skill_ref, version: `v:${files.get(`/repo/${r.skill_ref}`)}`, rate: 1, model_class: r.model_class });
    },
  };
  return { wiring, files, scratches, reruns };
}

/** The dev cases of each suite the fake runs replay; each suite also has one held-out case, `<ref>:h1`. */
const DEV_CASES = 10;

/**
 * A finished, measured run of `ref`'s suite (its stored pass rate `rate`): its dev cases pass at `devRate` (absent:
 * `rate`), a failing one answering no to each `failed` check with a reason, and its held-out case fails on
 * "held-out check". A measured (not scratch) run gets one `right` owner label.
 */
async function run(store: Store, clock: FakeClock, r: { id: string; ref: string; version: string; rate: number | null; devRate?: number; model_class?: string; failed?: string[] }): Promise<SkillEvalRun> {
  clock.advance(1000);
  const suite_id = `suite:${r.ref}`;
  await store.createSkillEvalSuite({ id: suite_id, skill_ref: r.ref, title: r.ref, created_by: OWNER });
  for (let i = 0; i < DEV_CASES; i++) await store.addSkillEvalCase({ id: `${r.ref}:d${i}`, suite_id, input: `in ${i}`, expected: ["x"] });
  await store.addSkillEvalCase({ id: `${r.ref}:h1`, suite_id, input: "held", expected: ["x"], split: "held-out" });
  await store.startSkillEvalRun({ id: r.id, suite_id, created_by: OWNER, skill_version: r.version });
  const answers = (r.failed ?? []).map((check) => ({ check, answer: "no", reason: `SECRET REASON for ${check}` }));
  const passing = Math.round((r.devRate ?? r.rate ?? 1) * DEV_CASES);
  for (let i = 0; i < DEV_CASES; i++) {
    const pass = i < passing;
    await store.recordSkillEvalReplay({ run_id: r.id, case_id: `${r.ref}:d${i}`, verdict: pass ? "pass" : "fail", detail: { answers: [...(pass ? [] : answers), { check: "passing check", answer: "yes", reason: "ok" }] } });
  }
  await store.recordSkillEvalReplay({ run_id: r.id, case_id: `${r.ref}:h1`, verdict: "fail", detail: { answers: [{ check: "held-out check", answer: "no", reason: "SECRET REASON held" }] } });
  await store.finishSkillEvalRun(r.id, passing < DEV_CASES ? "failed" : "passed");
  // The owner agrees with the judge on a measured run, so its skill is calibrated (judgeCalibrated) unless a test says otherwise.
  if (!r.version.startsWith("draft:")) await label(store, r.id, "right");
  if (r.rate !== null) {
    await store.recordSkillEvalRunFigures(r.id, { model_class: (r.model_class ?? "standard") as "standard", judge_model_class: "strong", replays: 1, pass_rate: r.rate, errored: 0 });
  }
  return (await store.getSkillEvalRun(r.id))!;
}

/** One owner label on the judge's answer to "passing check" of `run_id`'s first dev case, on replay `replay`. */
const label = (store: Store, run_id: string, verdict: "right" | "wrong", replay = 0) =>
  store.recordSkillEvalLabel({ run_id, case_id: `${run_id.replace(/-\d+$/, "")}:d0`, replay, check: "passing check", verdict, owner_id: OWNER });

/** Two runs of `ref` on its current version (`v:<text>`): 0.8, then `rate` (a drop past the margin by default). */
async function dropped(store: Store, clock: FakeClock, ref: string, text: string, rate = 0.5) {
  await run(store, clock, { id: `${ref}-1`, ref, version: `v:${text}`, rate: 0.8 });
  await run(store, clock, { id: `${ref}-2`, ref, version: `v:${text}`, rate, failed: ["cites the source", "names the file"] });
}

async function setup(o: Parameters<typeof fakeWiring>[2] = {}, llm = fakeLlm()) {
  const { store, clock } = await newStore();
  clock.set("2026-11-24T10:00:00.000Z");
  const f = fakeWiring(store as Store, clock, o);
  const deps = { store, scanner: cleanScanner, llm, clock, wiring: f.wiring, signal: signal() };
  return { store: store as Store, clock, llm, deps, ...f };
}

const fakeRun = (pass_rate: number | null, skill_version = "v1"): SkillEvalRun => ({
  id: "r", suite_id: "s", status: "failed", started_at: "t" as SkillEvalRun["started_at"], finished_at: "t" as SkillEvalRun["finished_at"], created_by: OWNER,
  skill_version, suite_version: 1, judge_version: "j1", factory_version: "dev", model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate, errored: 0,
});
/** Runs newest first from pass rates given oldest first. */
const history = (...rates: number[]) => rates.map((r) => fakeRun(r)).reverse();

describe("the trigger (skillTrigger)", () => {
  const c = SKILL_IMPROVE_DEFAULTS;

  it("drafts nothing at or above skill_improve_target, or with no measured run", () => {
    expect(skillTrigger(history(0.5, 0.9), c)).toBeNull();
    expect(skillTrigger([], c)).toBeNull();
    expect(skillTrigger([fakeRun(null)], c)).toBeNull();
  });

  it("drop: the newest measured run is more than skill_improve_drop_margin below the one before it", () => {
    expect(skillTrigger(history(0.8, 0.74), c)).toBe("drop");
    expect(skillTrigger(history(0.8, 0.76), c)).toBeNull();
    expect(skillTrigger(history(0.8, 0.74), { ...c, skill_improve_drop_margin: 0.1 })).toBeNull();
  });

  it("stall: the last skill_improve_stall_runs measured runs gain no more than skill_improve_noise", () => {
    expect(skillTrigger(history(0.5, 0.51, 0.52), c)).toBe("stall");
    expect(skillTrigger(history(0.5, 0.6, 0.7), c)).toBeNull();
    expect(skillTrigger(history(0.5, 0.52), c)).toBeNull(); // fewer runs than skill_improve_stall_runs
    expect(skillTrigger(history(0.5, 0.52), { ...c, skill_improve_stall_runs: 2 })).toBe("stall");
  });

  it("leaves out scratch runs and runs with no figures", () => {
    const scratch = { ...fakeRun(0.1), skill_version: scratchVersion("d") };
    expect(skillTrigger([scratch, ...history(0.8, 0.8)], c)).toBeNull();
    expect(skillTrigger([fakeRun(null), ...history(0.8, 0.5)], c)).toBe("drop");
  });

  it("leaves out baseline runs (eval run --baseline), as it leaves out scratch runs", () => {
    const baseline = { ...fakeRun(0.1), skill_version: baselineVersion("v1") };
    expect(skillTrigger([baseline, ...history(0.8, 0.8)], c)).toBeNull();
    expect(skillTrigger([baseline], c)).toBeNull();
  });
});

describe("drafting (improveSkills)", () => {
  it("drafts a triggered skill once: one call per skill, and a later improve run for the same version drafts nothing", async () => {
    const { store, clock, deps, llm } = await setup();
    await dropped(store, clock, A, "SKILL A");
    await run(store, clock, { id: "b-1", ref: B, version: "v:SKILL B", rate: 0.95 }); // at target: no draft

    const first = await improveSkills(deps, PROJECT);
    expect(first).toEqual([{ skill_ref: A, trigger: "drop", draft: { id: skillDraftId(PROJECT, A, "v:SKILL A"), state: "tried", reason: "untrusted" } }]);
    expect(llm.calls).toHaveLength(1);

    expect(await improveSkills(deps, PROJECT)).toEqual([{ skill_ref: A, trigger: "drop", draft: { skipped: "drafted" } }]);
    expect(llm.calls).toHaveLength(1);
    expect((await store.listSkillDrafts(PROJECT)).map((d) => d.skill_ref)).toEqual([A]);
  });

  it("the draft prompt holds the skill text and the failed check names only: no replay output, judge reason or run ID", async () => {
    const { store, clock, deps, llm } = await setup();
    await dropped(store, clock, A, "SKILL A");
    await improveSkills(deps, PROJECT);

    const req = llm.calls[0]!;
    expect(req).toMatchObject({ system: PROMPT, model_class: "standard", data_env: "test" });
    expect(req).not.toHaveProperty("tools");
    const message = req.messages.map((m) => m.content).join("\n");
    expect(message).toContain("cites the source");
    expect(message).toContain("names the file");
    expect(message).toContain("SKILL A");
    expect(message).not.toContain("passing check");
    expect(message).not.toContain("held-out check");
    expect(message).not.toContain("SECRET REASON");
    expect(message).not.toMatch(/skills\/a-[12]/);
  });

  it("measures the draft in scratch as the skill's system prompt, stores that run, and changes no skill file before a verdict", async () => {
    const { store, clock, deps, files, scratches } = await setup();
    await dropped(store, clock, A, "SKILL A");
    const before = new Map(files);
    await improveSkills(deps, PROJECT);

    const id = skillDraftId(PROJECT, A, "v:SKILL A");
    expect(scratches).toEqual([expect.objectContaining({ skill_ref: A, system_prompt: "NEW SKILL TEXT", skill_version: scratchVersion(id), model_class: "standard", split: "dev" })]);
    expect((await store.listSkillEvalRuns(A)).map((r) => r.id)).toContain(scratches[0]!.run_id);
    expect(files).toEqual(before);
  });

  it("a draft that beats the current version's latest run by more than skill_improve_noise, with no owner label, is stored tried untrusted; detail holds scores, never a transcript", async () => {
    const { store, clock, deps } = await setup({ scratchRate: 0.6 });
    await dropped(store, clock, A, "SKILL A");
    const [r] = await improveSkills(deps, PROJECT);

    expect(ownerLabelled(skillDraftId(PROJECT, A, "v:SKILL A"))).toBe(false); // no label source yet
    expect(r!.draft).toMatchObject({ state: "tried", reason: "untrusted" });
    const [draft] = await store.listSkillDrafts(PROJECT);
    expect(draft).toMatchObject({ state: "tried", tokens: 100 });
    expect(draft!.detail).toMatchObject({
      skill_version: "v:SKILL A", model_class: "standard", failed_checks: ["cites the source", "names the file"], draft: "NEW SKILL TEXT",
      baseline_run: { id: `${A}-2`, pass_rate: 0.5 }, scratch_run: { pass_rate: 0.6 },
    });
    expect(Object.keys(draft!.detail as object).sort()).toEqual(["baseline_run", "draft", "failed_checks", "gain", "model_class", "reason", "scratch_run", "skill_version"]);
    expect(JSON.stringify(draft!.detail)).not.toContain("SECRET REASON");
  });

  it("the gain is the dev scratch pass rate minus the dev pass rate of the current version's run, not its stored all-case rate", async () => {
    const { store, clock, deps } = await setup({ scratchRate: 0.6 });
    await run(store, clock, { id: `${A}-1`, ref: A, version: "v:SKILL A", rate: 0.8 });
    await run(store, clock, { id: `${A}-2`, ref: A, version: "v:SKILL A", rate: 0.5, devRate: 0.7, failed: ["cites the source"] });
    const [r] = await improveSkills(deps, PROJECT);
    expect(r!.draft).toMatchObject({ state: "tried", reason: "no_gain" });
    const [draft] = await store.listSkillDrafts(PROJECT);
    expect(draft!.detail).toMatchObject({ baseline_run: { id: `${A}-2`, pass_rate: 0.7 }, scratch_run: { pass_rate: 0.6 } });
    expect((draft!.detail as { gain: number }).gain).toBeCloseTo(-0.1);
  });

  it("with every case of the current version's run held out there is no dev baseline and no failed name reaches the draft call", async () => {
    const { store, clock, deps, llm } = await setup({ scratchRate: 0.9 });
    await dropped(store, clock, A, "SKILL A");
    for (let i = 0; i < 10; i++) await store.setSkillEvalCaseSplit(`${A}:d${i}`, "held-out");
    const [r] = await improveSkills(deps, PROJECT);
    expect(r!.draft).toMatchObject({ state: "tried", reason: "no_baseline" });
    const message = llm.calls[0]!.messages.map((m) => m.content).join("\n");
    for (const name of ["cites the source", "names the file", "held-out check"]) expect(message).not.toContain(name);
  });

  it("any other draft is stored tried with its reason", async () => {
    const cases: [Parameters<typeof fakeWiring>[2], LLMProvider | undefined, string][] = [
      [{ scratchRate: 0.51 }, undefined, "no_gain"],
      [{ scratch: "throw" }, undefined, "failed_replay"],
      [{ scratch: "none" }, undefined, "failed_replay"],
      [{ scratchRate: null }, undefined, "failed_replay"],
      [{}, fakeLlm(() => { throw new Error("down"); }), "failed_call"],
      [{}, fakeLlm(() => ({ ...reply(""), stop_reason: "refused" })), "failed_call"],
    ];
    for (const [o, llm, reason] of cases) {
      const { store, clock, deps } = await setup(o, llm as ReturnType<typeof fakeLlm> | undefined);
      await dropped(store, clock, A, "SKILL A");
      const [r] = await improveSkills(deps, PROJECT);
      expect(r!.draft, reason).toMatchObject({ state: "tried", reason });
      expect((await store.listSkillDrafts(PROJECT))[0], reason).toMatchObject({ state: "tried", detail: expect.objectContaining({ reason }) });
    }
  });

  it("no baseline: the current version has no measured run of the scratch run's model class", async () => {
    const { store, clock, deps } = await setup();
    await run(store, clock, { id: "old-1", ref: A, version: "v:OLD", rate: 0.8 });
    await run(store, clock, { id: "old-2", ref: A, version: "v:OLD", rate: 0.5 });
    const [r] = await improveSkills(deps, PROJECT);
    expect(r!.draft).toMatchObject({ state: "tried", reason: "no_baseline" });
  });

  it("only skills inside capabilities.skill_folders are drafted", async () => {
    const { store, clock, deps, llm } = await setup();
    await dropped(store, clock, "other/c", "SKILL C");
    expect(await improveSkills(deps, PROJECT)).toEqual([]);
    expect(llm.calls).toEqual([]);
  });
});

describe("judge calibration", () => {
  const unlabel = (store: Store, ref: string) => store.db.run(`DELETE FROM controller_skill_eval_labels WHERE run_id LIKE ?`, [`${ref}-%`]);

  it("a skill with no owner labels is skipped uncalibrated: no draft call, no draft, no day slot, no question", async () => {
    const { store, clock, deps, llm } = await setup({ config: { skill_drafts_per_day: 1 } });
    await dropped(store, clock, A, "SKILL A");
    await dropped(store, clock, B, "SKILL B");
    await unlabel(store, A);

    const results = await improveSkills(deps, PROJECT);
    expect(results.map((r) => [r.skill_ref, r.draft])).toEqual([[A, { skipped: "uncalibrated" }], [B, expect.objectContaining({ state: "tried" })]]);
    expect(llm.calls).toHaveLength(1);
    expect((await store.listSkillDrafts(PROJECT)).map((d) => d.skill_ref)).toEqual([B]);
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
  });

  it("agreement below 80% is uncalibrated; at 80% the skill is drafted", async () => {
    const below = await setup();
    await dropped(below.store, below.clock, A, "SKILL A"); // two right labels
    for (const replay of [1, 2]) await label(below.store, `${A}-2`, "wrong", replay); // 2 of 4: 50%
    expect((await improveSkills(below.deps, PROJECT)).map((r) => r.draft)).toEqual([{ skipped: "uncalibrated" }]);
    expect(below.llm.calls).toEqual([]);
    expect(await below.store.listSkillDrafts(PROJECT)).toEqual([]);

    const at = await setup();
    await dropped(at.store, at.clock, A, "SKILL A");
    for (const replay of [1, 2]) await label(at.store, `${A}-2`, "right", replay);
    await label(at.store, `${A}-2`, "wrong", 3); // 4 of 5: 80%
    expect((await improveSkills(at.deps, PROJECT)).map((r) => r.draft)).toEqual([expect.objectContaining({ state: "tried" })]);
    expect(at.llm.calls).toHaveLength(1);
  });
});

describe("the limits", () => {
  it("skill_drafts_per_day: past the cap no draft is taken and one owner question a UTC day names the value and the change; the run goes on", async () => {
    const { store, clock, deps, llm } = await setup({ config: { skill_drafts_per_day: 1 } });
    await dropped(store, clock, A, "SKILL A");
    await dropped(store, clock, B, "SKILL B");

    const results = await improveSkills(deps, PROJECT);
    expect(results.map((r) => r.draft)).toEqual([expect.objectContaining({ state: "tried", reason: "untrusted" }), { skipped: "day_cap" }]);
    expect(llm.calls).toHaveLength(1);
    await improveSkills(deps, PROJECT); // the same day: no second question
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toEqual([expect.objectContaining({ pattern: "skill_draft_limit", error_code: "skill_drafts_per_day", count: 1 })]);
    expect(alerts[0]!.detail).toMatch(/skill_drafts_per_day is 1.*skill_drafts_per_day 1 → 2/);

    clock.set("2026-11-25T10:00:00.000Z"); // the next UTC day: a new slot, so B is drafted and nothing is asked
    expect((await improveSkills(deps, PROJECT)).map((r) => r.draft)).toEqual([{ skipped: "drafted" }, expect.objectContaining({ state: "tried", reason: "untrusted" })]);
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
  });

  it("skill_drafts_per_day 0: no draft and no question", async () => {
    const { store, clock, deps, llm } = await setup({ config: { skill_drafts_per_day: 0 } });
    await dropped(store, clock, A, "SKILL A");
    expect((await improveSkills(deps, PROJECT)).map((r) => r.draft)).toEqual([{ skipped: "off" }]);
    expect(llm.calls).toEqual([]);
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    expect(await store.listSkillDrafts(PROJECT)).toEqual([]);
  });

  it("skill_draft_token_budget: a draft past it is held, unmeasured, with one owner question a UTC day", async () => {
    const { store, clock, deps, scratches } = await setup({ config: { skill_draft_token_budget: 50 } });
    await dropped(store, clock, A, "SKILL A");
    await dropped(store, clock, B, "SKILL B");

    const results = await improveSkills(deps, PROJECT);
    expect(results.map((r) => r.draft)).toEqual([expect.objectContaining({ state: "held", reason: "token_budget" }), expect.objectContaining({ state: "held", reason: "token_budget" })]);
    expect(scratches).toEqual([]);
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toEqual([expect.objectContaining({ pattern: "skill_draft_limit", error_code: "skill_draft_token_budget", count: 50 })]);
    expect(alerts[0]!.detail).toMatch(/skill_draft_token_budget is 50.*100 tokens.*skill_draft_token_budget 50 → 100/);
  });
});

describe("the verdicts", () => {
  /** A drafted skill's draft set proposed, as an owner label would let it be stored (none exists yet: it is stored tried untrusted). */
  async function proposed(o: Parameters<typeof fakeWiring>[2] = {}) {
    const s = await setup(o);
    await dropped(s.store, s.clock, A, "SKILL A");
    await improveSkills(s.deps, PROJECT);
    const id = skillDraftId(PROJECT, A, "v:SKILL A");
    expect(await s.store.setSkillDraftState(id, "tried", "proposed")).toBe(true);
    return { ...s, id, vd: { store: s.store, wiring: s.wiring, signal: signal() } };
  }

  it("promote runs the held-out check, keeps the old SKILL.md and both held-out pass rates in the detail, writes the draft, re-runs the suite, and sets the draft promoted", async () => {
    const { store, files, reruns, scratches, id, vd } = await proposed({ heldOut: { draft: 0.48, current: 0.5 } });
    const r = await promoteSkillDraft(vd, id, OWNER);

    expect(r).toEqual({ draft: expect.objectContaining({ id, state: "promoted" }) });
    expect(scratches.filter((x) => x.split === "held-out")).toEqual([
      expect.objectContaining({ skill_ref: A, system_prompt: "NEW SKILL TEXT", skill_version: heldOutVersion(id, "draft"), created_by: OWNER }),
      expect.objectContaining({ skill_ref: A, system_prompt: "SKILL A", skill_version: heldOutVersion(id, "current"), created_by: OWNER }),
    ]);
    expect(files.get("/repo/skills/a")).toBe("NEW SKILL TEXT");
    expect(reruns).toEqual([{ skill_ref: A, model_class: "standard", created_by: OWNER }]);
    const draft = (await store.getSkillDraft(id))!;
    expect(draft.detail).toMatchObject({ old_text: "SKILL A", promoted_run: { pass_rate: 1 }, held_out: { draft: { pass_rate: 0.48 }, current: { pass_rate: 0.5 } } });
    const promoted_run = (draft.detail as { promoted_run: { id: string } }).promoted_run.id;
    expect(await store.getSkillEvalRun(promoted_run)).toMatchObject({ skill_version: "v:NEW SKILL TEXT" });
  });

  it("promote is refused with nothing changed when the held-out check fails: the draft scores more than skill_improve_noise below the current text, a run gives no pass rate, or a model call fails", async () => {
    const cases: [HeldOut, RegExp][] = [
      [{ draft: 0.4, current: 0.5 }, /0\.4 on held-out cases against 0\.5/],
      [{ draft: null }, /gave no pass rate/],
      [{ current: null }, /gave no pass rate/],
      [{ throw: true }, /gave no pass rate/],
    ];
    for (const [heldOut, why] of cases) {
      const { store, files, reruns, id, vd } = await proposed({ heldOut });
      const before = await store.getSkillDraft(id);
      expect(await promoteSkillDraft(vd, id, OWNER)).toEqual({ refused: expect.stringMatching(why) });
      expect(files.get("/repo/skills/a")).toBe("SKILL A");
      expect(reruns).toEqual([]);
      expect(await store.getSkillDraft(id)).toEqual(before);
    }
  });

  it("promote of a suite with no held-out case is refused, saying so, with nothing changed and nothing replayed", async () => {
    const { store, files, reruns, scratches, id, vd } = await proposed();
    await store.setSkillEvalCaseSplit(`${A}:h1`, "dev");
    const before = await store.getSkillDraft(id);
    const replayed = scratches.length;
    expect(await promoteSkillDraft(vd, id, OWNER)).toEqual({ refused: expect.stringContaining("no held-out case") });
    expect(scratches).toHaveLength(replayed);
    expect(files.get("/repo/skills/a")).toBe("SKILL A");
    expect(reruns).toEqual([]);
    expect(await store.getSkillDraft(id)).toEqual(before);
  });

  it("promote of a skill outside capabilities.skill_folders is refused with nothing written", async () => {
    const { store, files, reruns, id, vd } = await proposed();
    const before = await store.getSkillDraft(id);
    const outside = { ...vd, wiring: { ...vd.wiring, skill_folders: ["/repo/elsewhere"] } };
    const filesBefore = new Map(files);

    expect(await promoteSkillDraft(outside, id, OWNER)).toEqual({ refused: expect.stringContaining("capabilities.skill_folders") });
    expect(files).toEqual(filesBefore);
    expect(reruns).toEqual([]);
    expect(await store.getSkillDraft(id)).toEqual(before);
  });

  it("hold moves proposed to held; reject moves proposed or held to rejected; nothing else changes", async () => {
    const { store, files, id } = await proposed();
    const filesBefore = new Map(files);
    expect(await holdSkillDraft(store, id)).toEqual({ draft: expect.objectContaining({ state: "held" }) });
    expect(await holdSkillDraft(store, id)).toEqual({ refused: expect.stringContaining("held") });
    expect(await rejectSkillDraft(store, id)).toEqual({ draft: expect.objectContaining({ state: "rejected" }) });
    expect(files).toEqual(filesBefore);

    const other = await proposed();
    expect(await rejectSkillDraft(other.store, other.id)).toEqual({ draft: expect.objectContaining({ state: "rejected" }) });
  });

  it("a second verdict on a decided draft changes nothing", async () => {
    const { store, files, reruns, id, vd } = await proposed();
    await promoteSkillDraft(vd, id, OWNER);
    const decided = await store.getSkillDraft(id);
    files.set("/repo/skills/a", "EDITED BY HAND");

    expect(await promoteSkillDraft(vd, id, OWNER)).toEqual({ refused: expect.stringContaining("promoted") });
    expect(await rejectSkillDraft(store, id)).toEqual({ refused: expect.stringContaining("promoted") });
    expect(await holdSkillDraft(store, id)).toEqual({ refused: expect.stringContaining("promoted") });
    expect(await store.getSkillDraft(id)).toEqual(decided);
    expect(files.get("/repo/skills/a")).toBe("EDITED BY HAND");
    expect(reruns).toHaveLength(1);

    const r = await proposed();
    await rejectSkillDraft(r.store, r.id);
    const rejected = await r.store.getSkillDraft(r.id);
    expect(await promoteSkillDraft(r.vd, r.id, OWNER)).toEqual({ refused: expect.stringContaining("rejected") });
    expect(await r.store.getSkillDraft(r.id)).toEqual(rejected);
    expect(r.files.get("/repo/skills/a")).toBe("SKILL A");
  });
});

describe("the improve run", () => {
  /** One daily improve run on a worker with `skillImprove` (absent: none), after learnFromReport. */
  async function improveRun(withWiring: boolean, o: Parameters<typeof fakeWiring>[2] = {}, tacit?: TacitHandOff) {
    const { store, clock } = await newStore();
    clock.set("2026-11-24T10:00:00.000Z");
    const f = fakeWiring(store as Store, clock, o);
    await dropped(store as Store, clock, A, "SKILL A");
    await dropped(store as Store, clock, B, "SKILL B");
    const llm = fakeLlm();
    await new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, llm }).tickImprove();
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(), llm,
      ...(withWiring ? { skillImprove: f.wiring } : {}), ...(tacit ? { tacit } : {}),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    expect(await worker.tick()).toBe(true);
    const item = (await store.getWorkItemBySource("local", systemSource(CONFIG_PROJECT.key).id))!;
    const [run] = (await store.listRuns(item.id)).filter((r) => r.kind === "improve");
    return { store, llm, run: run!, project: CONFIG_PROJECT.key };
  }

  it("drafts the triggered skills after the report; at the daily cap it asks once and still succeeds", async () => {
    const { store, run, project } = await improveRun(true, { config: { skill_drafts_per_day: 1 } });
    expect(run.outcome).toMatchObject({
      status: "succeeded",
      data: { skill_drafts: [{ skill_ref: A, trigger: "drop", state: "tried" }, { skill_ref: B, trigger: "drop", skipped: "day_cap" }] },
    });
    expect((await store.listSkillDrafts(project)).map((d) => [d.skill_ref, d.state])).toEqual([[A, "tried"]]);
    expect(await store.listAlerts({ limit: 10 })).toEqual([expect.objectContaining({ pattern: "skill_draft_limit" })]);
  });

  it("with the worker's tacit ledger on, a draft with no owner label is stored tried untrusted and is not handed to it", async () => {
    const proposals: string[] = [];
    const tacit: TacitHandOff = { enabled: true, changeProposal: async (p) => void proposals.push(p.target), verdictRecord: async () => {} };
    const { run, store, project } = await improveRun(true, {}, tacit);
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { skill_drafts: [{ skill_ref: A, state: "tried" }, { skill_ref: B, state: "tried" }] } });
    expect((await store.listSkillDrafts(project)).map((d) => (d.detail as { reason?: string }).reason)).toEqual(["untrusted", "untrusted"]);
    expect(proposals).toEqual([]);
  });

  it("past the token budget the draft is held, one question is asked, and the run still succeeds", async () => {
    const { run, store } = await improveRun(true, { config: { skill_draft_token_budget: 10 } });
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { skill_drafts: [{ state: "held" }, { state: "held" }] } });
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
  });

  it("with capabilities.skill_folders absent (no wiring) no draft is taken and no question is asked", async () => {
    const { store, llm, run, project } = await improveRun(false);
    expect(run.outcome).toMatchObject({ status: "succeeded" });
    expect(run.outcome).not.toHaveProperty("data.skill_drafts");
    expect(llm.calls.filter((c) => c.system === PROMPT)).toEqual([]);
    expect(await store.listSkillDrafts(project)).toEqual([]);
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
  });
});
