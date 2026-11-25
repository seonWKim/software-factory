// Skill improvement (design 07-self-improvement): the improve run reads each seeded skill's measured eval runs and,
// for a skill below skill_improve_target whose score dropped or stalled, drafts one new SKILL.md with one plain model
// call that sees only the failed check names of `dev` cases, only when the owner's labels calibrate the skill's judge
// (judgeCalibrated: labels, and agreement at 80% or more; else skipped `uncalibrated`, before a day slot is taken). The draft is measured in scratch (the suite's dev cases
// replayed with the draft as the skill's system prompt, the run stored) and stored `proposed` when it beats the current
// version's latest run on its dev cases by more than skill_improve_noise and carries an owner label (ownerLabelled),
// else `tried` with its reason. Scratch (`draft:`) and baseline (`baseline:`) runs are never read as measured. No skill
// file changes before a verdict: promote, reject and hold are the functions below, each a conditional change of the
// draft row; promote first checks the draft against the current text on the `held-out` cases. A seeded skill is a suite whose
// skill_ref is inside capabilities.skill_folders; with none configured the composition root passes no wiring and the
// feature is off. File reads and writes, the replay and the judge come through SkillImproveWiring (src/skill-evals.ts).
// With the owner's tacit ledger on, each `proposed` draft and each verdict the store accepts on it are also handed to
// the ledger, after the store holds them; a ledger failure is logged and changes nothing here (`handOff`).

import { cyrb53 } from "./hash.js";
import { judgeCalibrated } from "./skill-eval-calibration.js";
import { errorText, type Logger } from "./log.js";
import { MODEL_CLASSES, type ModelClass } from "./model-choice.js";
import type { SkillImproveConfig } from "./skill-improve-config.js";
import type { UserId } from "./types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { LLMProvider, LLMResponse } from "../interfaces/llm-provider.js";
import type { SkillDraft, SkillDraftState } from "../interfaces/skill-draft-store.js";
import type { SkillEvalReplay, SkillEvalRun, SkillEvalSplit } from "../interfaces/skill-eval-store.js";
import type { TacitChangeProposal, TacitHandOff, TacitLedger, TacitVerdictRecord } from "../interfaces/tacit-ledger.js";

/** Who starts the scratch runs. */
export const SKILL_IMPROVER = "system:skill-improve" as UserId;
/** The skill_version of a scratch run: never a folder's version, so no trigger or baseline reads it as the skill's. */
export const scratchVersion = (draft_id: string) => `draft:${draft_id}`;
/** The skill_version of a held-out run before a promotion, of the draft text or the current SKILL.md text: a scratch run too. */
export const heldOutVersion = (draft_id: string, text: "draft" | "current") => `${scratchVersion(draft_id)}:held-out:${text}`;
/** The skill_version of a baseline run (`eval run --baseline`): the suite with no skill, beside the folder's version it was run at. */
export const baselineVersion = (folder_hash: string) => `baseline:${folder_hash}`;
/** Whether `skill_version` names a run that replays no folder version as the skill's: a scratch run or a baseline run. */
const unmeasuredVersion = (skill_version: string | null) => skill_version !== null && (skill_version.startsWith("draft:") || skill_version.startsWith("baseline:"));
const DAY_MS = 86_400_000;
const DRAFT_TIMEOUT_MS = 120_000;
const DRAFT_MAX_TOKENS = 16_000;
/** Pass rates are fractions: a change of exactly a margin is within it (the golden compare's epsilon). */
const past = (change: number, margin: number) => change > margin + 1e-9;

/** What the composition root builds (src/skill-evals.ts skillImproveWiring); absent: capabilities.skill_folders is not set. */
export interface SkillImproveWiring {
  config: SkillImproveConfig;
  /** capabilities.skill_folders, absolute and normalized. */
  skill_folders: readonly string[];
  /** A skill_ref's folder, absolute and normalized. */
  folderOf(skill_ref: string): string;
  /** prompts/skill-improve.md; null when it cannot be read (then nothing is drafted). */
  prompt(): Promise<string | null>;
  /** The folder's SKILL.md; null when unreadable. */
  readSkill(folder: string): Promise<string | null>;
  writeSkill(folder: string, text: string): Promise<void>;
  /** The folder's version (capabilities skillVersion); null when unreadable. */
  version(folder: string): Promise<string | null>;
  /** The `split` cases of the skill's suite run with `system_prompt` as the skill's system prompt, judged, stored with its figures; null when nothing ran. */
  scratch(r: { skill_ref: string; system_prompt: string; run_id: string; skill_version: string; model_class: ModelClass; created_by: UserId; split: SkillEvalSplit }, signal: AbortSignal): Promise<SkillEvalRun | null>;
  /** The skill's suite run with its SKILL.md as it is now (`eval run`), stored; null when nothing ran. */
  rerun(r: { skill_ref: string; model_class: ModelClass; created_by: UserId }, signal: AbortSignal): Promise<SkillEvalRun | null>;
  newId(): string;
}

type Store = Pick<FactoryStore,
  "listSkillEvalSuites" | "listSkillEvalCases" | "listSkillEvalRuns" | "listSkillEvalReplays" | "listSkillEvalLabels" | "getSkillDraft" | "addSkillDraft" | "setSkillDraftState" | "takeSkillDraftSlot" | "recordAlert">;

export interface SkillImproveDeps {
  store: Store;
  scanner: EgressScanner;
  /** The improve run's metered provider: the draft call's usage counts toward the run's. */
  llm: LLMProvider;
  /** The injected Clock (only its now): the owner question's UTC day. */
  clock: { now(): Date };
  wiring: SkillImproveWiring;
  signal: AbortSignal;
  /** The owner's tacit ledger and where its failures are logged; absent or off: nothing is handed off. */
  ledger?: SkillLedger | undefined;
}

/** The owner's tacit ledger as the skill hand-off reads it, and the log a failed hand-off is written to. */
export interface SkillLedger {
  tacit: TacitHandOff;
  log: Logger;
}

/**
 * Hands one stored record to the ledger when it is on: its failure is logged and never thrown, so the stored draft and
 * the verdict's result stay as they are with the ledger off.
 */
async function handOff(ledger: SkillLedger | undefined, r: { proposal: TacitChangeProposal } | { verdict: TacitVerdictRecord }): Promise<void> {
  if (!ledger?.tacit.enabled) return;
  const id = "proposal" in r ? r.proposal.id : r.verdict.id;
  try {
    if ("proposal" in r) await ledger.tacit.changeProposal?.(r.proposal);
    else await ledger.tacit.verdictRecord?.(r.verdict);
  } catch (err) {
    ledger.log.warn("skill draft not handed to the tacit ledger; the factory keeps it", { id, record: "proposal" in r ? "proposal" : r.verdict.decision, error: errorText(err) });
  }
}

/**
 * Starts a live tacit holder (src/runtime/live-tacit.ts) through `start`, with a build that remembers the plugin it last
 * built, and returns it with the hand-off: `enabled` from the holder, which delegates neither method, and the two
 * methods on that plugin (a failed build keeps it; a plugin without a method sends nothing for it).
 */
export async function withHandOff<H extends { readonly enabled: boolean }>(
  start: (build: (name: string) => Promise<TacitLedger>) => Promise<H>, make: (name: string) => Promise<TacitLedger>,
): Promise<{ holder: H; handOff: TacitHandOff }> {
  let inUse: TacitLedger | undefined;
  const holder = await start(async (name) => (inUse = await make(name)));
  const handOff: TacitHandOff = {
    get enabled() { return holder.enabled; },
    changeProposal: async (p) => inUse?.changeProposal?.(p),
    verdictRecord: async (v) => inUse?.verdictRecord?.(v),
  };
  return { holder, handOff };
}

/** The file a skill draft changes, as the ledger names it. */
const skillTarget = (skill_ref: string) => `${skill_ref}/SKILL.md`;

/** Why a skill fell below its target: its newest measured run dropped, or its last runs gained nothing. */
export type SkillTrigger = "drop" | "stall";
/** Why a draft is `tried` (or `held`, for token_budget). */
export type DraftReason = "failed_call" | "withheld" | "failed_replay" | "no_baseline" | "no_gain" | "token_budget" | "untrusted";

/** What one improve run did per seeded skill below its target. */
export interface SkillImproveResult {
  skill_ref: string;
  trigger: SkillTrigger;
  /** The draft stored, or why none was taken. */
  draft: { id: string; state: SkillDraftState; reason?: DraftReason } | { skipped: "drafted" | "uncalibrated" | "day_cap" | "off" | "unreadable" };
}

/** A run with figures, not a scratch run and not a baseline run. */
const measured = (runs: readonly SkillEvalRun[]) => runs.filter((r) => r.pass_rate !== null && r.finished_at !== null && !unmeasuredVersion(r.skill_version));

/**
 * The trigger (newest first): none when there is no measured run or the newest is at or above skill_improve_target.
 * `drop`: the newest is more than skill_improve_drop_margin below the run before it. `stall`: there are at least
 * skill_improve_stall_runs measured runs and the newest of them is no more than skill_improve_noise above the oldest.
 */
export function skillTrigger(runs: readonly SkillEvalRun[], c: SkillImproveConfig): SkillTrigger | null {
  const m = measured(runs);
  const [newest, before] = m;
  if (!newest || newest.pass_rate! >= c.skill_improve_target) return null;
  if (before && past(before.pass_rate! - newest.pass_rate!, c.skill_improve_drop_margin)) return "drop";
  const oldest = m[c.skill_improve_stall_runs - 1];
  return oldest && !past(newest.pass_rate! - oldest.pass_rate!, c.skill_improve_noise) ? "stall" : null;
}

/** Whether `folder` is inside (or is) one of the skill folders. */
export function insideSkillFolders(folder: string, folders: readonly string[]): boolean {
  return folders.some((f) => folder === f || folder.startsWith(f.endsWith("/") ? f : `${f}/`));
}

/** One draft per project, skill and skill version: a later improve run for that version finds it and drafts nothing. */
export const skillDraftId = (project: string, skill_ref: string, version: string) => `skd_${cyrb53(`${project}\0${skill_ref}\0${version}`)}`;

/** Each seeded skill below its target gets at most one draft (design 07-self-improvement). Never fails the improve run for a draft's fault. */
export async function improveSkills(d: SkillImproveDeps, project: string): Promise<SkillImproveResult[]> {
  const { wiring: w } = d;
  const refs = [...new Set((await d.store.listSkillEvalSuites()).map((s) => s.skill_ref))].filter((r) => insideSkillFolders(w.folderOf(r), w.skill_folders));
  const out: SkillImproveResult[] = [];
  for (const skill_ref of refs) {
    const runs = await d.store.listSkillEvalRuns(skill_ref);
    const trigger = skillTrigger(runs, w.config);
    if (trigger === null) continue;
    out.push({ skill_ref, trigger, draft: await draftSkill(d, project, skill_ref, measured(runs)) });
  }
  return out;
}

async function draftSkill(d: SkillImproveDeps, project: string, skill_ref: string, runs: SkillEvalRun[]): Promise<SkillImproveResult["draft"]> {
  const w = d.wiring, c = w.config;
  if (c.skill_drafts_per_day === 0) return { skipped: "off" };
  const folder = w.folderOf(skill_ref);
  const [version, text, prompt] = await Promise.all([w.version(folder), w.readSkill(folder), w.prompt()]);
  if (version === null || text === null || prompt === null) return { skipped: "unreadable" };
  const id = skillDraftId(project, skill_ref, version);
  if (await d.store.getSkillDraft(id)) return { skipped: "drafted" };
  // The judge's answers are trusted only with the owner's labels at CALIBRATION_THRESHOLD or above, checked before a slot is taken.
  if (!judgeCalibrated(await d.store.listSkillEvalLabels(skill_ref))) return { skipped: "uncalibrated" };
  if (!(await d.store.takeSkillDraftSlot(project, c.skill_drafts_per_day))) {
    const cap = c.skill_drafts_per_day;
    await limitQuestion(d, project, "skill_drafts_per_day", cap, `skill_drafts_per_day is ${cap}: today's skill drafts are taken, so ${skill_ref} was not drafted. Proposed change: skill_drafts_per_day ${cap} → ${cap + 1}.`);
    return { skipped: "day_cap" };
  }
  const model_class = classOf(runs[0]!);
  const dev = await devReplays(d.store, runs[0]!);
  const failed_checks = failedChecks(dev);
  const base = { skill_version: version, model_class, failed_checks };
  const store = async (state: SkillDraftState, tokens: number, detail: Record<string, unknown>) => {
    const reason = detail.reason as DraftReason | undefined;
    await d.store.addSkillDraft({ id, project_key: project, skill_ref, state, tokens, detail: { ...base, ...detail } });
    return { id, state, ...(reason ? { reason } : {}) };
  };

  const call = await callDraft(d, prompt, text, failed_checks);
  if ("failed" in call) return store("tried", call.tokens, { reason: "failed_call", call: call.failed });
  const scan = await d.scanner.scan("log", call.text);
  if (!scan.clean) return store("tried", call.tokens, { reason: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))] });
  if (call.tokens > c.skill_draft_token_budget) {
    const limit = c.skill_draft_token_budget;
    await limitQuestion(d, project, "skill_draft_token_budget", limit, `skill_draft_token_budget is ${limit}: the draft of ${skill_ref} used ${call.tokens} tokens, so it is held. Proposed change: skill_draft_token_budget ${limit} → ${call.tokens}.`);
    return store("held", call.tokens, { reason: "token_budget", draft: call.text, budget: { tokens: call.tokens, limit } });
  }

  const scratch = await scratchOrNull(d.signal, w.scratch({ skill_ref, system_prompt: call.text, run_id: w.newId(), skill_version: scratchVersion(id), model_class, created_by: SKILL_IMPROVER, split: "dev" }, d.signal));
  const drafted = { draft: call.text, ...(scratch ? { scratch_run: { id: scratch.id, pass_rate: scratch.pass_rate } } : {}) };
  if (!scratch || scratch.pass_rate === null) return store("tried", call.tokens, { ...drafted, reason: "failed_replay" });
  const baselineRun = runs.find((r) => r.skill_version === version && r.model_class === model_class);
  const baseline = baselineRun ? { id: baselineRun.id, pass_rate: passRate(baselineRun.id === runs[0]!.id ? dev : await devReplays(d.store, baselineRun)) } : null;
  if (!baseline || baseline.pass_rate === null) return store("tried", call.tokens, { ...drafted, reason: "no_baseline" });
  const gain = scratch.pass_rate - baseline.pass_rate;
  const scores = { ...drafted, baseline_run: baseline, gain };
  if (!past(gain, c.skill_improve_noise)) return store("tried", call.tokens, { ...scores, reason: "no_gain" });
  if (!ownerLabelled(id)) return store("tried", call.tokens, { ...scores, reason: "untrusted" });
  const stored = await store("proposed", call.tokens, scores);
  const checks = failed_checks.length > 0 ? failed_checks.join("; ") : "none recorded";
  await handOff(d.ledger, { proposal: {
    id, target: skillTarget(skill_ref), title: `Improve ${skill_ref}: pass rate ${baseline.pass_rate} → ${scratch.pass_rate}`,
    rationale: `Its newest eval run on ${model_class} failed these checks: ${checks}. The draft scored ${scratch.pass_rate} in scratch against ${baseline.pass_rate} for the current version.`,
    change: call.text,
  } });
  return stored;
}

/**
 * Whether draft `id` carries an owner label, the owner's mark that its skill may be proposed (design
 * 07-self-improvement). No label source exists yet, so none does: every draft that would be proposed is stored `tried`
 * with reason `untrusted`, and nothing is handed to the ledger.
 */
export function ownerLabelled(_id: string): boolean {
  return false;
}

/** The model class of the newest measured run (the scratch run and its baseline use it); `standard` when it names none. */
function classOf(run: SkillEvalRun): ModelClass {
  return MODEL_CLASSES.find((c) => c === run.model_class) ?? "standard";
}

/** A scratch run, or null when it threw (an abort is thrown on). */
function scratchOrNull(signal: AbortSignal, run: Promise<SkillEvalRun | null>): Promise<SkillEvalRun | null> {
  return run.catch((err: unknown) => { if (signal.aborted) throw err; return null; });
}

/** The replays of `run` whose case is a `dev` case of its suite now: a held-out or deleted case's replays are left out. */
async function devReplays(store: Pick<Store, "listSkillEvalCases" | "listSkillEvalReplays">, run: SkillEvalRun): Promise<SkillEvalReplay[]> {
  const [cases, replays] = await Promise.all([store.listSkillEvalCases(run.suite_id), store.listSkillEvalReplays(run.id)]);
  const dev = new Set(cases.filter((c) => c.split === "dev").map((c) => c.id));
  return replays.filter((r) => dev.has(r.case_id));
}

/** Pass verdicts ÷ replays, as a run's figures count them; null with no replay. */
function passRate(replays: readonly SkillEvalReplay[]): number | null {
  return replays.length === 0 ? null : replays.filter((r) => r.verdict === "pass").length / replays.length;
}

/** The check texts the judge answered no to in `replays` (dev cases only), in order, each once. Never an output or a reason. */
function failedChecks(replays: readonly SkillEvalReplay[]): string[] {
  const names = new Set<string>();
  for (const r of replays) {
    const answers = (r.detail as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(answers)) continue;
    for (const a of answers as { check?: unknown; answer?: unknown }[]) if (a.answer === "no" && typeof a.check === "string") names.add(a.check);
  }
  return [...names];
}

/** The draft's user message: the skill's current text and the failed check names, nothing else. */
export function draftMessage(skill_text: string, failed_checks: readonly string[]): string {
  const checks = failed_checks.length > 0 ? failed_checks.map((c) => `- ${c}`).join("\n") : "- (no check names were recorded)";
  return `The skill's current SKILL.md:\n<skill>\n${skill_text}\n</skill>\n\nChecks its last eval run failed:\n${checks}`;
}

/** One plain completion: no tools, no sandbox. Its text is the whole new SKILL.md. */
async function callDraft(d: SkillImproveDeps, system: string, text: string, failed_checks: readonly string[]): Promise<{ text: string; tokens: number } | { failed: string; tokens: number }> {
  let res: LLMResponse;
  try {
    res = await d.llm.complete({
      model_class: "standard", system, messages: [{ role: "user", content: draftMessage(text, failed_checks) }], max_tokens: DRAFT_MAX_TOKENS,
      data_env: "test", signal: AbortSignal.any([d.signal, AbortSignal.timeout(DRAFT_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (d.signal.aborted) throw err;
    return { failed: "error", tokens: 0 };
  }
  const tokens = res.usage.input_tokens + res.usage.output_tokens;
  if (res.stop_reason !== "end") return { failed: res.stop_reason, tokens };
  return res.text.trim() === "" ? { failed: "empty", tokens } : { text: res.text, tokens };
}

/** One owner question per limit, project and UTC day (alert pattern skill_draft_limit), its text scanned as UI text first. */
async function limitQuestion(d: SkillImproveDeps, project: string, key: string, value: number, text: string): Promise<void> {
  const day = d.clock.now().toISOString().slice(0, 10);
  const detail = (await d.scanner.scan("ui", text)).clean ? text : null;
  await d.store.recordAlert({ pattern: "skill_draft_limit", pattern_key: `skill_draft_limit:${key}:${project}:${day}`, error_code: key, count: value, detail }, DAY_MS);
}

// ---- Verdicts. Each is a conditional change of the draft row: a second verdict on a decided draft changes nothing.

export type SkillVerdict = { draft: SkillDraft } | { refused: string };
type VerdictStore = Pick<FactoryStore, "getSkillDraft" | "setSkillDraftState">;

/** proposed → held. */
export function holdSkillDraft(store: VerdictStore, id: string, ledger?: SkillLedger): Promise<SkillVerdict> {
  return decide(store, id, ["proposed"], "held", "hold", ledger);
}

/** proposed or held → rejected. */
export function rejectSkillDraft(store: VerdictStore, id: string, ledger?: SkillLedger): Promise<SkillVerdict> {
  return decide(store, id, ["proposed", "held"], "rejected", "reject", ledger);
}

async function decide(
  store: VerdictStore, id: string, from: readonly SkillDraftState[], to: SkillDraftState, decision: TacitVerdictRecord["decision"], ledger: SkillLedger | undefined,
): Promise<SkillVerdict> {
  const draft = await store.getSkillDraft(id);
  if (!draft) return { refused: `no skill draft ${id}` };
  if (!from.includes(draft.state) || !(await store.setSkillDraftState(id, draft.state, to))) return { refused: `skill draft ${id} is ${draft.state}: nothing changed` };
  await recordVerdict(ledger, draft, decision);
  return { draft: (await store.getSkillDraft(id))! };
}

/**
 * The verdict the store accepted on `draft` (as it was before it), to the ledger: only for a draft that was proposed,
 * so a draft stored `held` past its token budget, never handed off, sends none.
 */
function recordVerdict(ledger: SkillLedger | undefined, draft: SkillDraft, decision: TacitVerdictRecord["decision"]): Promise<void> {
  const reason = ((draft.detail ?? {}) as Record<string, unknown>).reason;
  if (draft.state !== "proposed" && !(draft.state === "held" && reason !== "token_budget")) return Promise.resolve();
  return handOff(ledger, { verdict: { id: draft.id, decision, target: skillTarget(draft.skill_ref), reason: `The owner's ${decision} of skill draft ${draft.id} in the factory.` } });
}

type PromoteStore = VerdictStore & Pick<FactoryStore, "listSkillEvalSuites" | "listSkillEvalCases">;

/**
 * proposed or held → promoted: runs the held-out check (heldOutCheck), then stores the old SKILL.md text and both
 * held-out pass rates in the draft's detail, writes the draft to SKILL.md, re-runs the suite (the run is stored) and
 * sets the draft promoted with that run. Refused, nothing written, for a skill outside capabilities.skill_folders, a
 * decided draft, an unreadable skill, or a held-out check that refuses.
 */
export async function promoteSkillDraft(
  d: { store: PromoteStore; wiring: SkillImproveWiring; signal: AbortSignal }, id: string, created_by: UserId, ledger?: SkillLedger,
): Promise<SkillVerdict> {
  const draft = await d.store.getSkillDraft(id);
  if (!draft) return { refused: `no skill draft ${id}` };
  const folder = d.wiring.folderOf(draft.skill_ref);
  if (!insideSkillFolders(folder, d.wiring.skill_folders)) return { refused: `${draft.skill_ref} is not inside capabilities.skill_folders: nothing written` };
  if (draft.state !== "proposed" && draft.state !== "held") return { refused: `skill draft ${id} is ${draft.state}: nothing changed` };
  const detail = (draft.detail ?? {}) as Record<string, unknown>;
  const old = await d.wiring.readSkill(folder);
  if (typeof detail.draft !== "string" || old === null) return { refused: `skill draft ${id} has no text or ${draft.skill_ref}/SKILL.md cannot be read: nothing written` };
  const model_class = MODEL_CLASSES.find((c) => c === detail.model_class) ?? "standard";
  const held_out = await heldOutCheck(d, { id, skill_ref: draft.skill_ref, draft: detail.draft, current: old, model_class, created_by });
  if ("refused" in held_out) return held_out;
  const kept = { ...detail, old_text: typeof detail.old_text === "string" ? detail.old_text : old, held_out };
  if (!(await d.store.setSkillDraftState(id, draft.state, draft.state, kept))) return { refused: `skill draft ${id} changed meanwhile: nothing written` };
  await d.wiring.writeSkill(folder, detail.draft);
  const run = await d.wiring.rerun({ skill_ref: draft.skill_ref, model_class, created_by }, d.signal);
  const promoted = await d.store.setSkillDraftState(id, draft.state, "promoted", { ...kept, promoted_run: run ? { id: run.id, pass_rate: run.pass_rate } : null });
  if (promoted) await recordVerdict(ledger, draft, "promote");
  return { draft: (await d.store.getSkillDraft(id))! };
}

type HeldOutScore = { id: string; pass_rate: number };

/**
 * The check before a promotion (design 07-self-improvement): the draft text and the current SKILL.md text each run in
 * scratch on the suite's `held-out` cases. Their pass rates when the draft's is not more than skill_improve_noise below
 * the current text's; else refused, as it is when the suite has no held-out case or a run gives no pass rate (a failed
 * model call). Writes no file and no draft state; its two runs are stored as scratch runs.
 */
async function heldOutCheck(
  d: { store: PromoteStore; wiring: SkillImproveWiring; signal: AbortSignal },
  r: { id: string; skill_ref: string; draft: string; current: string; model_class: ModelClass; created_by: UserId },
): Promise<{ draft: HeldOutScore; current: HeldOutScore } | { refused: string }> {
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill_ref);
  const held = suite ? (await d.store.listSkillEvalCases(suite.id)).filter((c) => c.split === "held-out") : [];
  if (held.length === 0) return { refused: `${r.skill_ref} has no held-out case, so skill draft ${r.id} cannot be checked before promotion: nothing written` };
  const scratch = async (text: "draft" | "current"): Promise<HeldOutScore | null> => {
    const run = await scratchOrNull(d.signal, d.wiring.scratch({
      skill_ref: r.skill_ref, system_prompt: r[text], run_id: d.wiring.newId(), skill_version: heldOutVersion(r.id, text), model_class: r.model_class, created_by: r.created_by, split: "held-out",
    }, d.signal));
    return run && run.pass_rate !== null ? { id: run.id, pass_rate: run.pass_rate } : null;
  };
  const draft = await scratch("draft");
  const current = draft ? await scratch("current") : null;
  if (!draft || !current) return { refused: `the held-out check of skill draft ${r.id} gave no pass rate (a replay or model call failed): nothing written` };
  if (past(current.pass_rate - draft.pass_rate, d.wiring.config.skill_improve_noise)) {
    return { refused: `skill draft ${r.id} scored ${draft.pass_rate} on held-out cases against ${current.pass_rate} for the current text, more than skill_improve_noise below it: nothing written` };
  }
  return { draft, current };
}
