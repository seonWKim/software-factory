// Root wiring of skill evals (design 06-measurement): what `factory eval run <skill>` runs. It finds the skill's
// suite, builds the engine's parts from the configured plugins (the replay over the sandbox and runner plugins, the
// judge over the llm plugin with prompts/skill-judge.md, the G5 egress scan, the skill folder's version), runs one
// run through runSkillEval, then records the run's figures through the store. The engine is unchanged. The run's
// options (--model, --judge-model, --replays) are checked here before anything is read or written.
//
// main.ts passes skillEvalRun to every command through the command call (CommandCall.runSkillEval), so the CLI
// handler imports no root or legacy module.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Loaded, Plugins } from "./compose.js";
import { judgeClass, skillJudge } from "./core/scorer.js";
import { MODEL_CLASSES, type ModelClass } from "./core/model-choice.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SkillEvalRun, SkillEvalRunFigures, SkillEvalStore } from "./interfaces/skill-eval-store.js";
import { skillFolderPath, skillVersion } from "./runtime/capabilities/capabilities.js";
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
  store: Pick<SkillEvalStore, "listSkillEvalSuites" | "getSkillEvalRun" | "recordSkillEvalRunFigures" | "startSkillEvalRun" | "listSkillEvalCases" | "listSkillEvalReplays" | "recordSkillEvalReplay" | "finishSkillEvalRun" | "getSkillEvalCase">;
  /** Where a relative skill folder resolves. */
  root: string;
  /** prompts/skill-judge.md, the judge's system prompt. */
  judgePrompt(): Promise<string>;
  plugins(): Promise<SkillEvalPlugins>;
  repo: { path: string; base_branch: string };
  deny_paths: readonly string[];
  timeout_ms: number;
  newId(): string;
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

/** The engine's replay, judge and scan for `skill` on `model_class`, or why they cannot be built (its SKILL.md is unreadable). */
async function engineParts(d: SkillEvalWiring, skill: string, model_class: ModelClass): Promise<{ engine: Omit<SkillEvalEngineDeps, "store">; skill_version: string } | { refused: string }> {
  const folder = skillFolderPath(skill, d.root);
  const [skill_text, skill_version] = await Promise.all([readFile(join(folder, "SKILL.md"), "utf8").catch(() => null), skillVersion(folder).catch(() => null)]);
  if (skill_text === null || skill_version === null) return { refused: `cannot read ${skill}/SKILL.md: nothing run` };
  const [p, system] = await Promise.all([d.plugins(), d.judgePrompt()]);
  const replay = skillEvalReplay(p, {
    repo: d.repo, role: REPLAY_ROLE, system_prompt: skill_text, env_allowlist: {}, deny_paths: d.deny_paths, model_class, timeout_ms: d.timeout_ms,
  });
  const scan = async (text: string) => (await p.scanner.scan("log", text)).clean;
  return { engine: { replay, judge: skillJudge(p.llm, system, model_class), scan }, skill_version };
}

/**
 * Runs one skill eval of `r.skill`'s suite (its first, by creation), then records the run's figures. Refuses, naming
 * the skill and writing no run, when no suite exists for it or its folder's SKILL.md cannot be read, and on an option
 * runClass refuses.
 */
export async function runSkillEvalFor(d: SkillEvalWiring, r: SkillEvalRequest): Promise<SkillEvalResult> {
  const chosen = runClass(r);
  if ("refused" in chosen) return chosen;
  const { model_class } = chosen;
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill);
  if (!suite) return { refused: `no skill eval suite for ${r.skill}: nothing run` };
  const parts = await engineParts(d, r.skill, model_class);
  if ("refused" in parts) return parts;
  const id = d.newId();
  const outcome = await runSkillEval({ store: d.store, ...parts.engine }, { id, suite_id: suite.id, created_by: r.created_by, skill_version: parts.skill_version }, r.signal);
  if (outcome.status !== null) await d.store.recordSkillEvalRunFigures(id, runFigures(model_class, outcome.verdicts));
  const run = await d.store.getSkillEvalRun(id);
  if (!run) throw new Error(`skill eval run ${id} was not stored`);
  return { run };
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
  return tryCase({ store: d.store, ...parts.engine }, r.case_id, r.signal);
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
