// Root wiring of skill evals (design 06-measurement): what `factory eval run <skill>` runs. It finds the skill's
// suite, builds the engine's parts from the configured plugins (the replay over the sandbox and runner plugins, the
// judge over the llm plugin with prompts/skill-judge.md, the G5 egress scan, the skill folder's version), runs one
// run through runSkillEval, then records the run's figures through the store. The engine is unchanged. The run's
// options (--model, --judge-model, --replays) are checked here before anything is read or written. A run replays the
// skill's current version (its folder as it is now) by default; `version` names a stored version of the imported skill
// by its folder hash (design 06-measurement), and the run replays that version's text and stores its hash.
//
// main.ts passes skillEvalRun to every command through the command call (CommandCall.runSkillEval), so the CLI
// handler imports no root or legacy module. The composition root builds the improve run's skill improvement wiring
// here (skillImproveWiring, design 07-self-improvement): the scratch run, the re-run after a promote, and SKILL.md I/O.

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { codeVersion } from "./config-values.js";
import { capabilitiesConfig, skillImproveConfig } from "./core/config.js";
import type { SkillImproveWiring } from "./core/skill-improve.js";
import type { UserId } from "./core/types.js";
import type { Loaded } from "./load-config.js";
import { Plugins } from "./plugin-set.js";
import { judgeClass, skillJudge } from "./core/scorer.js";
import { MODEL_CLASSES, type ModelClass } from "./core/model-choice.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import { CODE_VERSION_ENV } from "./interfaces/updater.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SkillEvalRun, SkillEvalRunFigures, SkillEvalStore } from "./interfaces/skill-eval-store.js";
import { skillFolderPath, skillVersion } from "./runtime/capabilities/capabilities.js";
import { skillVersionsOf } from "./ui/plugins-api.js";
import { type Authored, type CaseVerdict, type SkillEvalAuthoring, type SkillEvalEngineDeps, type TriedCase, addSkillEvalCase, addSkillEvalSuite, deleteSkillEvalSuite, editSkillEvalCase, renameSkillEvalSuite, runSkillEval, skillEvalReplay, tryCase } from "./runtime/index.js";

/** The class a skill-eval replay runs on when no --model is given; its judge runs on judgeClass of it. */
export const SKILL_EVAL_CLASS: ModelClass = "standard";
/** The role a replay runs as: no tools, no session, no writable path (skillEvalReplay). */
const REPLAY_ROLE = "implement";

/** One `eval run`: the skill's ref (its suite's `skill_ref`, a skill folder), who starts it, and its stop signal. */
export interface SkillEvalRequest {
  skill: string;
  /** A user or agent ID, never a display name. */
  created_by: string;
  signal: AbortSignal;
  /** --model: the replays' model class, as stored (absent: SKILL_EVAL_CLASS). */
  model_class?: string | undefined;
  /** --judge-model: must be judgeClass of the model class (absent: that class). */
  judge_model_class?: string | undefined;
  /** --replays: replays per case; only 1, since a run records one verdict per case (absent: 1). */
  replays?: number | undefined;
  /** A previous version's folder hash (an `ext_skill_versions` row of the skill) to re-run (absent: the current version). */
  version?: string | undefined;
}

/** The stored run with its figures, or why nothing was run (and no run written). */
export type SkillEvalResult = { run: SkillEvalRun } | { refused: string };

/** The plugins a run calls, built only once the skill's suite and files are found. */
export interface SkillEvalPlugins {
  sandbox: Sandbox;
  runner: AgentRunner;
  llm: LLMProvider;
  scanner: EgressScanner;
}

export interface SkillEvalWiring {
  store: Pick<SkillEvalStore, "listSkillEvalSuites" | "getSkillEvalRun" | "recordSkillEvalRunFigures" | "startSkillEvalRun" | "listSkillEvalCases" | "listSkillEvalReplays" | "recordSkillEvalReplay" | "finishSkillEvalRun" | "getSkillEvalCase" | "listSkillEvalRuns" | "listSkillVersions">;
  /** Where a relative skill folder resolves. */
  root: string;
  /** prompts/skill-judge.md, the judge's system prompt. */
  judgePrompt(): Promise<string>;
  plugins(): Promise<SkillEvalPlugins>;
  repo: { path: string; base_branch: string };
  deny_paths: readonly string[];
  timeout_ms: number;
  newId(): string;
  /** The factory revision stored on each run (SF_CODE_VERSION); absent: `dev`, as the worker stamps runs. */
  factory_version?: string;
}

/** The judge's version: the SHA-256 of its system prompt, so a run judged by another prompt is told apart. */
export const judgeVersion = (prompt: string): string => createHash("sha256").update(prompt).digest("hex");

/** The engine's store with the run's judge and factory versions added to its start (the suite version the store reads). */
function versionedStore(store: SkillEvalWiring["store"], v: { judge_version: string; factory_version: string }): SkillEvalEngineDeps["store"] {
  return {
    // The engine passes the run's created_by as text; it is the request's user or agent ID.
    startSkillEvalRun: (r) => store.startSkillEvalRun({ ...r, created_by: r.created_by as UserId, skill_version: r.skill_version ?? null, ...v }),
    listSkillEvalCases: (id) => store.listSkillEvalCases(id),
    listSkillEvalReplays: (id) => store.listSkillEvalReplays(id),
    recordSkillEvalReplay: (r) => store.recordSkillEvalReplay(r),
    finishSkillEvalRun: (id, status) => store.finishSkillEvalRun(id, status),
  };
}

/** A run's figures from its verdicts: one replay per case, pass verdicts ÷ replays (null with none), errored cases. */
export function runFigures(model_class: ModelClass, verdicts: readonly { verdict: CaseVerdict }[]): SkillEvalRunFigures {
  const replays = verdicts.length;
  const passed = verdicts.filter((v) => v.verdict === "pass").length;
  return {
    model_class, judge_model_class: judgeClass(model_class), replays,
    pass_rate: replays === 0 ? null : passed / replays, errored: verdicts.filter((v) => v.verdict === "errored").length,
  };
}

const isModelClass = (v: string): v is ModelClass => (MODEL_CLASSES as readonly string[]).includes(v);

/** The replays' class from the request's options, or why the run is refused (nothing read or written yet). */
export function runClass(r: Pick<SkillEvalRequest, "model_class" | "judge_model_class" | "replays">): { model_class: ModelClass } | { refused: string } {
  const model_class = r.model_class ?? SKILL_EVAL_CLASS;
  if (!isModelClass(model_class)) return { refused: `--model ${model_class}: no such model class; use one of ${MODEL_CLASSES.join(", ")}: nothing run` };
  const judge = judgeClass(model_class);
  if (r.judge_model_class !== undefined && r.judge_model_class !== judge) {
    return { refused: `--judge-model ${r.judge_model_class}: the judge runs on ${judge}, the judge class of ${model_class}: nothing run` };
  }
  if (r.replays !== undefined && r.replays !== 1) {
    return { refused: `--replays ${r.replays}: a run stores one verdict per case, so it replays each case once: nothing run` };
  }
  return { model_class };
}

/** The engine's replay (with `system_prompt` as the skill's system prompt), judge and scan on `model_class`. */
async function engineOf(d: SkillEvalWiring, system_prompt: string, model_class: ModelClass): Promise<Engine> {
  const [p, system] = await Promise.all([d.plugins(), d.judgePrompt()]);
  const replay = skillEvalReplay(p, {
    repo: d.repo, role: REPLAY_ROLE, system_prompt, env_allowlist: {}, deny_paths: d.deny_paths, model_class, timeout_ms: d.timeout_ms,
  });
  const scan = async (text: string) => (await p.scanner.scan("log", text)).clean;
  return { replay, judge: skillJudge(p.llm, system, model_class), scan, judge_version: judgeVersion(system) };
}

/** The engine's replay, judge and scan, and the judge's version a run stores. */
type Engine = Omit<SkillEvalEngineDeps, "store"> & { judge_version: string };

/** The engine's parts for `skill`'s SKILL.md as it is now on `model_class`, or why they cannot be built (its SKILL.md is unreadable). */
async function engineParts(d: SkillEvalWiring, skill: string, model_class: ModelClass): Promise<{ engine: Engine; skill_version: string } | { refused: string }> {
  const folder = skillFolderPath(skill, d.root);
  const [skill_text, skill_version] = await Promise.all([readFile(join(folder, "SKILL.md"), "utf8").catch(() => null), skillVersion(folder).catch(() => null)]);
  if (skill_text === null || skill_version === null) return { refused: `cannot read ${skill}/SKILL.md: nothing run` };
  return { engine: await engineOf(d, skill_text, model_class), skill_version };
}

/**
 * The engine's parts for the stored version `hash` of `skill` on `model_class`: its text as the system prompt, its hash
 * as the run's. The skill's versions are those of the imported skill that holds its folder's hash now or one of its
 * runs' hashes (skillVersionsOf); a hash that is none of them is refused.
 */
async function versionParts(d: SkillEvalWiring, skill: string, hash: string, model_class: ModelClass): Promise<{ engine: Engine; skill_version: string } | { refused: string }> {
  const now = await skillVersion(skillFolderPath(skill, d.root)).catch(() => null);
  const versions = await skillVersionsOf(d.store, [now, ...(await d.store.listSkillEvalRuns(skill)).map((r) => r.skill_version)]);
  const v = versions.find((x) => x.folder_hash === hash);
  if (!v) return { refused: `${skill} has no version ${hash}: nothing run` };
  return { engine: await engineOf(d, v.text, model_class), skill_version: v.folder_hash };
}

/** Runs the suite through the engine as run `id`, records its figures and returns the stored run. */
async function runAndRecord(
  d: SkillEvalWiring, engine: Engine, r: { id: string; suite_id: string; created_by: string; skill_version: string; model_class: ModelClass }, signal: AbortSignal,
): Promise<SkillEvalRun> {
  const { judge_version, ...parts } = engine;
  const store = versionedStore(d.store, { judge_version, factory_version: d.factory_version ?? "dev" });
  const outcome = await runSkillEval({ store, ...parts }, { id: r.id, suite_id: r.suite_id, created_by: r.created_by, skill_version: r.skill_version }, signal);
  if (outcome.status !== null) await d.store.recordSkillEvalRunFigures(r.id, runFigures(r.model_class, outcome.verdicts));
  const run = await d.store.getSkillEvalRun(r.id);
  if (!run) throw new Error(`skill eval run ${r.id} was not stored`);
  return run;
}

/**
 * Runs one skill eval of `r.skill`'s suite (its first, by creation) on its current version, or on `r.version`, then
 * records the run's figures. Refuses, naming the skill and writing no run, when no suite exists for it, its folder's
 * SKILL.md cannot be read, `r.version` is no version of it, and on an option runClass refuses.
 */
export async function runSkillEvalFor(d: SkillEvalWiring, r: SkillEvalRequest): Promise<SkillEvalResult> {
  const chosen = runClass(r);
  if ("refused" in chosen) return chosen;
  const { model_class } = chosen;
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill);
  if (!suite) return { refused: `no skill eval suite for ${r.skill}: nothing run` };
  const parts = r.version === undefined ? await engineParts(d, r.skill, model_class) : await versionParts(d, r.skill, r.version, model_class);
  if ("refused" in parts) return parts;
  const run = await runAndRecord(d, parts.engine, { id: d.newId(), suite_id: suite.id, created_by: r.created_by, skill_version: parts.skill_version, model_class }, r.signal);
  return { run };
}

/**
 * A scratch run (design 07-self-improvement): `skill`'s suite replayed with `system_prompt` (a draft) as the skill's
 * system prompt instead of its SKILL.md, judged, stored under `skill_version` with its figures. Reads no skill file and
 * writes none. Null when the skill has no suite.
 */
export async function scratchRunFor(
  d: SkillEvalWiring, r: { skill_ref: string; system_prompt: string; run_id: string; skill_version: string; model_class: ModelClass; created_by: UserId }, signal: AbortSignal,
): Promise<SkillEvalRun | null> {
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill_ref);
  if (!suite) return null;
  return runAndRecord(d, await engineOf(d, r.system_prompt, r.model_class), { id: r.run_id, suite_id: suite.id, created_by: r.created_by, skill_version: r.skill_version, model_class: r.model_class }, signal);
}

/** The improve run's skill improvement over `d` (SkillImproveWiring): `folders` are capabilities.skill_folders, absolute. */
export function improveWiring(d: SkillEvalWiring, config: SkillImproveWiring["config"], folders: readonly string[], prompt: () => Promise<string | null>): SkillImproveWiring {
  return {
    config, skill_folders: folders.map((f) => resolve(f)), prompt, newId: d.newId,
    folderOf: (ref) => resolve(skillFolderPath(ref, d.root)),
    readSkill: (folder) => readFile(join(folder, "SKILL.md"), "utf8").catch(() => null),
    writeSkill: (folder, text) => writeFile(join(folder, "SKILL.md"), text, "utf8"),
    version: (folder) => skillVersion(folder).catch(() => null),
    scratch: (r, signal) => scratchRunFor(d, r, signal),
    rerun: async (r, signal) => {
      const res = await runSkillEvalFor(d, { skill: r.skill_ref, model_class: r.model_class, created_by: r.created_by, signal });
      return "run" in res ? res.run : null;
    },
  };
}

/** One `eval case try <case>`: the case id, the class the replay runs on, and the stop signal. */
export interface SkillEvalTryRequest {
  case_id: string;
  /** One of cheap, standard, strong; any other value is refused. */
  model_class: string;
  signal: AbortSignal;
}

/** Replays and judges one case through the engine's replay and judge on `r.model_class`; stores no run and no replay. */
export async function tryCaseFor(d: SkillEvalWiring, r: SkillEvalTryRequest): Promise<Authored<TriedCase>> {
  const model_class = MODEL_CLASSES.find((c) => c === r.model_class);
  if (!model_class) return { refused: `--model must be one of ${MODEL_CLASSES.join(", ")}` };
  const c = await d.store.getSkillEvalCase(r.case_id);
  if (!c) return { refused: `no skill eval case ${r.case_id}` };
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.id === c.suite_id);
  if (!suite) return { refused: `no skill eval suite for case ${r.case_id}` };
  const parts = await engineParts(d, suite.skill_ref, model_class);
  if ("refused" in parts) return parts;
  const { judge_version: _unused, ...engine } = parts.engine;
  return tryCase({ store: d.store, ...engine }, r.case_id, r.signal);
}

/**
 * The worker's skill improvement wiring (WorkerDeps.skillImprove) over its own plugins; undefined when
 * capabilities.skill_folders is absent or empty: then the improve run drafts no skill and asks nothing.
 */
export function skillImproveWiring(store: SkillEvalWiring["store"], loaded: Loaded, plugins: SkillEvalPlugins): SkillImproveWiring | undefined {
  const folders = capabilitiesConfig(loaded.file).skill_folders;
  if (folders.length === 0) return undefined;
  const prompt = () => readFile(join(loaded.codeRoot, "prompts", "skill-improve.md"), "utf8").catch(() => null);
  return improveWiring({ ...wiringOf(store, loaded), plugins: async () => plugins }, skillImproveConfig(loaded.file), folders.map((f) => skillFolderPath(f, loaded.root)), prompt);
}

/** The configured plugins and wiring over `store`, as `skillEvalRun` and `skillEvalTry` build them. */
function wiringOf(store: SkillEvalWiring["store"], loaded: Loaded): SkillEvalWiring {
  const plugins = async (): Promise<SkillEvalPlugins> => {
    const p = new Plugins(loaded);
    const secrets = await p.secrets();
    const sandbox = await p.sandbox();
    return { sandbox, runner: await p.runner(sandbox, secrets), llm: await p.llm(secrets), scanner: await p.scanner(secrets) };
  };
  return {
    store, root: loaded.root, plugins, judgePrompt: () => readFile(join(loaded.codeRoot, "prompts", "skill-judge.md"), "utf8"),
    repo: loaded.config.repo, deny_paths: loaded.config.deny_paths, timeout_ms: loaded.config.run_timeout_ms, newId: () => randomUUID(),
    ...(() => { const v = codeVersion(process.env[CODE_VERSION_ENV]).code_version; return v ? { factory_version: v } : {}; })(),
  };
}

/** `factory eval run <skill>` over the configured plugins and `store` (CommandCall.runSkillEval, built by main.ts). */
export function skillEvalRun(store: SkillEvalWiring["store"], loaded: Loaded, r: SkillEvalRequest): Promise<SkillEvalResult> {
  return runSkillEvalFor(wiringOf(store, loaded), r);
}

/** `factory eval case try <case>` over the configured plugins and `store` (CommandCall.trySkillEvalCase, built by main.ts). */
export function skillEvalTry(store: SkillEvalWiring["store"], loaded: Loaded, r: SkillEvalTryRequest): Promise<Authored<TriedCase>> {
  return tryCaseFor(wiringOf(store, loaded), r);
}

/** The suite and case authoring calls with this wiring's ids (CommandCall.authoring, built by main.ts). */
export const skillEvalAuthoring: SkillEvalAuthoring = {
  addSuite: (store, r) => addSkillEvalSuite({ store, newId: () => randomUUID() }, r),
  renameSuite: renameSkillEvalSuite,
  deleteSuite: deleteSkillEvalSuite,
  addCase: (store, skill, f) => addSkillEvalCase({ store, newId: () => randomUUID() }, skill, f),
  editCase: editSkillEvalCase,
};
