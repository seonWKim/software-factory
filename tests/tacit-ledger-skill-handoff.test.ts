import { describe, expect, it } from "vitest";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import type { UserId } from "../src/core/types.js";
import { type TacitChangeProposal, type TacitHandOff, type TacitLedger, type TacitVerdictRecord } from "../src/interfaces/tacit-ledger.js";
import type { LLMProvider } from "../src/interfaces/llm-provider.js";
import type { LogFields, Logger } from "../src/core/log.js";
import { type SkillImproveWiring, type SkillLedger, holdSkillDraft, improveSkills, promoteSkillDraft, rejectSkillDraft, skillDraftId, withHandOff } from "../src/core/skill-improve.js";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import { cleanScanner, config } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { reject, verdict } from "./helpers/tacit-ledger-stub.js";

// The skill hand-off (design 07-self-improvement): with the ledger on, each skill draft stored `proposed` and each
// verdict the store accepts on it also go to the ledger, after the store holds them. No draft carries an owner label
// yet, so an improve run stores a gaining draft `tried` (untrusted) and hands nothing; `propose` sets it proposed. A fake ledger records the calls
// and can be told to throw; the model, the scratch run and the skill files are fakes: no CLI, no model.
describe("the skill hand-off (src/core/skill-improve.ts)", () => {
  const SKILL = "skills/a";
  const OWNER = "local:owner" as UserId;

  /** A ledger that records each hand-off and throws on each when `fail` is set. */
  function fakeLedger(o: { enabled?: boolean; fail?: boolean } = {}) {
    const proposals: TacitChangeProposal[] = [];
    const verdicts: TacitVerdictRecord[] = [];
    const tacit: TacitHandOff = {
      enabled: o.enabled ?? true,
      changeProposal: async (p) => { proposals.push(p); if (o.fail) throw new Error("ledger locked"); },
      verdictRecord: async (v) => { verdicts.push(v); if (o.fail) throw new Error("ledger locked"); },
    };
    const warns: { msg: string; fields: LogFields | undefined }[] = [];
    const log: Logger = { info() {}, error() {}, warn: (msg, fields) => void warns.push({ msg, fields }) };
    return { tacit, log, proposals, verdicts, warns };
  }

  /** A store with skills/a's score dropped (0.8 → 0.5 on v:SKILL A) on dev case c1, and held-out case h1; each scratch run scores `scratchRate`. */
  async function dropped(scratchRate = 1) {
    const { store, clock } = await newStore();
    clock.set("2026-11-24T10:00:00.000Z");
    const files = new Map([["/repo/skills/a", "SKILL A"]]);
    const measured = async (id: string, version: string, rate: number, failed: string[] = []) => {
      clock.advance(1000);
      await store.createSkillEvalSuite({ id: `suite:${SKILL}`, skill_ref: SKILL, title: SKILL, created_by: OWNER });
      await store.startSkillEvalRun({ id, suite_id: `suite:${SKILL}`, created_by: OWNER, skill_version: version });
      await store.recordSkillEvalReplay({ run_id: id, case_id: "c1", verdict: "fail", detail: { answers: failed.map((check) => ({ check, answer: "no", reason: "r" })) } });
      await store.finishSkillEvalRun(id, "failed");
      await store.recordSkillEvalRunFigures(id, { model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate: rate, errored: 0 });
      return (await store.getSkillEvalRun(id))!;
    };
    await store.createSkillEvalSuite({ id: `suite:${SKILL}`, skill_ref: SKILL, title: SKILL, created_by: OWNER });
    await store.addSkillEvalCase({ id: "c1", suite_id: `suite:${SKILL}`, input: "in", expected: ["x"] });
    await store.addSkillEvalCase({ id: "h1", suite_id: `suite:${SKILL}`, input: "held", expected: ["x"], split: "held-out" });
    await measured("r1", "v:SKILL A", 0.8);
    await measured("r2", "v:SKILL A", 0.5, ["cites the source"]);
    // The owner agrees with the judge, so the skill is calibrated and self-improve drafts it.
    await store.recordSkillEvalLabel({ run_id: "r2", case_id: "c1", replay: 0, check: "cites the source", verdict: "right", owner_id: OWNER });
    const wiring: SkillImproveWiring = {
      config: SKILL_IMPROVE_DEFAULTS, skill_folders: ["/repo/skills"], folderOf: (ref) => `/repo/${ref}`, prompt: async () => "PROMPT",
      readSkill: async (f) => files.get(f) ?? null, writeSkill: async (f, t) => void files.set(f, t), version: async (f) => `v:${files.get(f)}`,
      newId: () => "scratch1", scratch: async (r) => measured(r.run_id, r.skill_version, scratchRate), rerun: async () => null,
    };
    const llm: LLMProvider = { complete: async () => ({ text: "NEW SKILL TEXT", stop_reason: "end", usage: { input_tokens: 50, output_tokens: 50, cost_usd: null } }) };
    const deps = { store, scanner: cleanScanner, llm, clock, wiring, signal: new AbortController().signal };
    const id = skillDraftId("local:p", SKILL, "v:SKILL A");
    return { store, deps, files, id, vd: { store, wiring, signal: deps.signal } };
  }

  /** The drafted skill's draft set proposed, as an owner label would let it be stored (none exists yet). */
  async function propose(s: Awaited<ReturnType<typeof dropped>>) {
    expect(await s.store.setSkillDraftState(s.id, "tried", "proposed")).toBe(true);
  }

  /** Each draft row and the verdicts' results, run once with `ledger` (absent: the plugin off). */
  async function judged(ledger?: SkillLedger) {
    const s = await dropped();
    const drafted = await improveSkills({ ...s.deps, ...(ledger ? { ledger } : {}) }, "local:p");
    await propose(s);
    const proposed = await s.store.getSkillDraft(s.id);
    const held = await holdSkillDraft(s.store, s.id, ledger);
    const promoted = await promoteSkillDraft(s.vd, s.id, OWNER, ledger);
    const again = await rejectSkillDraft(s.store, s.id, ledger);
    return { drafted, proposed, held, promoted, again, file: s.files.get("/repo/skills/a") };
  }

  it("with the ledger on, a gaining draft with no owner label is stored tried untrusted and is not handed off", async () => {
    const s = await dropped();
    const l = fakeLedger();
    expect(await improveSkills({ ...s.deps, ledger: l }, "local:p")).toEqual([expect.objectContaining({ draft: expect.objectContaining({ state: "tried", reason: "untrusted" }) })]);
    await improveSkills({ ...s.deps, ledger: l }, "local:p");
    expect((await s.store.getSkillDraft(s.id))?.state).toBe("tried");
    expect(l.proposals).toEqual([]);
    expect(l.verdicts).toEqual([]);
  });

  it("a draft that is not proposed (tried) is not handed off", async () => {
    const s = await dropped(0.5);
    const l = fakeLedger();
    expect(await improveSkills({ ...s.deps, ledger: l }, "local:p")).toEqual([expect.objectContaining({ draft: expect.objectContaining({ state: "tried" }) })]);
    expect(l.proposals).toEqual([]);
  });

  it("each hold, reject or promote the store accepts is recorded; a refused verdict sends nothing", async () => {
    const s = await dropped();
    const l = fakeLedger();
    await improveSkills({ ...s.deps, ledger: l }, "local:p");
    await propose(s);
    expect(await holdSkillDraft(s.store, s.id, l)).toEqual({ draft: expect.objectContaining({ state: "held" }) });
    expect(await holdSkillDraft(s.store, s.id, l)).toEqual({ refused: expect.any(String) });
    expect(await promoteSkillDraft(s.vd, s.id, OWNER, l)).toEqual({ draft: expect.objectContaining({ state: "promoted" }) });
    expect(await rejectSkillDraft(s.store, s.id, l)).toEqual({ refused: expect.any(String) });
    expect(await promoteSkillDraft(s.vd, s.id, OWNER, l)).toEqual({ refused: expect.any(String) });
    expect(await holdSkillDraft(s.store, "skd_none", l)).toEqual({ refused: expect.any(String) });
    expect(l.verdicts.map((v) => [v.id, v.decision, v.target])).toEqual([[s.id, "hold", "skills/a/SKILL.md"], [s.id, "promote", "skills/a/SKILL.md"]]);

    const r = await dropped();
    const lr = fakeLedger();
    await improveSkills({ ...r.deps, ledger: lr }, "local:p");
    await propose(r);
    await rejectSkillDraft(r.store, r.id, lr);
    expect(lr.verdicts.map((v) => v.decision)).toEqual(["reject"]);
  });

  it("a draft stored held past its token budget was never proposed: a verdict on it sends nothing", async () => {
    const s = await dropped();
    const l = fakeLedger();
    await improveSkills({ ...s.deps, wiring: { ...s.deps.wiring, config: { ...SKILL_IMPROVE_DEFAULTS, skill_draft_token_budget: 10 } }, ledger: l }, "local:p");
    expect(await rejectSkillDraft(s.store, s.id, l)).toEqual({ draft: expect.objectContaining({ state: "rejected" }) });
    expect(l.proposals).toEqual([]);
    expect(l.verdicts).toEqual([]);
  });

  it("with the ledger off (the none plugin, or enabled false) no call is made and the draft and verdicts are as with no ledger", async () => {
    const off = fakeLedger({ enabled: false });
    const none = new NoTacitLedger();
    const without = await judged();
    expect(without.proposed?.state).toBe("proposed");
    expect(await judged({ tacit: off.tacit, log: off.log })).toEqual(without);
    expect(await judged({ tacit: none, log: off.log })).toEqual(without);
    expect([off.proposals, off.verdicts, off.warns]).toEqual([[], [], []]);
  });

  it("withHandOff: enabled comes from the holder, and each method goes to the plugin the holder last built", async () => {
    const built: string[] = [];
    const plugin = (name: string): TacitLedger => Object.assign(new NoTacitLedger(), name === "on" ? { verdictRecord: async (v: TacitVerdictRecord) => void built.push(`${name}:${v.id}`) } : {});
    const holder = { enabled: false, build: undefined as undefined | ((n: string) => Promise<TacitLedger>) };
    const { handOff } = await withHandOff(async (build) => (await build("off"), Object.assign(holder, { build })), async (n) => plugin(n));
    expect(handOff.enabled).toBe(false);
    await handOff.verdictRecord!({ id: "skd_1", decision: "hold", target: "t", reason: "r" });
    await holder.build!("on");
    holder.enabled = true;
    expect(handOff.enabled).toBe(true);
    await handOff.verdictRecord!({ id: "skd_2", decision: "hold", target: "t", reason: "r" });
    await handOff.changeProposal!({ id: "skd_2", target: "t", title: "t", rationale: "r", change: "c" });
    expect(built).toEqual(["on:skd_2"]);
  });

  it("a ledger failure is logged and changes neither the stored draft nor any verdict's result", async () => {
    const without = await judged();
    const l = fakeLedger({ fail: true });
    expect(await judged({ tacit: l.tacit, log: l.log })).toEqual(without);
    expect(l.proposals).toEqual([]);
    expect(l.verdicts.map((v) => v.decision)).toEqual(["hold", "promote"]);
    expect(l.warns.map((w) => w.fields?.record)).toEqual(["hold", "promote"]);
    expect(l.warns.every((w) => w.fields?.error === "ledger locked")).toBe(true);
  });
});
