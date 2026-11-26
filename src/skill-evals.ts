// Root wiring of skill evals (design 06-measurement): what `factory eval run <skill>` runs. It finds the skill's
// suite, builds the engine's parts from the configured plugins (the replay over the sandbox and runner plugins, the
// judges over the llm plugin with prompts/skill-judge.md and prompts/skill-judge-pairwise.md, the previous version's
// answers a pairwise check compares against, the G5 egress scan, the skill folder's version), runs one
// run through runSkillEval (each case --replays times), then records the run's figures through the store. The run's
// options (--model, --judge-model, --replays 1 to 10) are checked here before anything is read or written. A run replays the
// skill's current version (its folder as it is now) by default; `version` names a stored version of the imported skill
// by its folder hash (design 06-measurement), and the run replays that version's text and stores its hash. `baseline`
// (`eval run --baseline`, design 07-self-improvement) replays the suite with no skill: an empty system prompt, no skill
// folder or SKILL.md in the sandbox and no tools from front matter, stored as `baseline:<folder hash>`.
//
// Each replay runs in a clean sandbox (design 06-measurement, clean replays): the `sandbox` plugin's name (a replay with
// tools is refused under `noop`), the skill's folder, the approved pack MCP servers a case names, and the Clock's time
// for its wall time come from here; the scan gives the engine the rule names a stored transcript or answer matched.
// A skill whose `tools:` front matter names a tool gets the configured ToolBroker behind G2 (brokerGuard, the one guard
// work-item runs use too) and a run passport per replay run, narrowed to its granted tools (design 06-measurement).
//
// main.ts passes skillEvalRun to every command through the command call (CommandCall.runSkillEval), so the CLI
// handler imports no root or legacy module. The composition root builds the improve run's skill improvement wiring
// here (skillImproveWiring, design 07-self-improvement): the scratch run (one split's cases only), the re-run after a
// promote (every case, as `eval run`), and SKILL.md I/O.
// The new-version gate pass (gatedImport, design 07-self-improvement) runs a new version's suite through
// runSkillEvalFor on that stored version, after a plugin import records one.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { codeVersion } from "./config-values.js";
import { type ToolGrants, capabilitiesConfig, skillImproveConfig, toolGrantsConfig } from "./core/config.js";
import { type SkillImproveWiring, baselineVersion } from "./core/skill-improve.js";
import { type SkillGateWiring, runSkillVersionGates } from "./core/skill-eval-gate.js";
import type { UserId } from "./core/types.js";
import { type Loaded, localProject } from "./load-config.js";
import { Plugins } from "./plugin-set.js";
import { createPlugin } from "./plugins.js";
import { judgeClass, skillJudge, skillPairwiseJudge, skillRubricJudge } from "./core/scorer.js";
import { MODEL_CLASSES, type ModelClass } from "./core/model-choice.js";
import type { AgentRunner, PackMcpServer } from "./interfaces/agent-runner.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import { CODE_VERSION_ENV } from "./interfaces/updater.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import { type PassportService, startIdentity } from "./identity/index.js";
import { PassportToolBroker } from "./impl/broker/passport-broker.js";
import { packToolBrokers } from "./impl/broker/pack-tools.js";
import { RunPassports } from "./worker/passports/run-passports.js";
import { storeProjectResolver } from "./ui/settings-api.js";
import type { SkillEvalRun, SkillEvalRunFigures, SkillEvalSplit, SkillEvalStore } from "./interfaces/skill-eval-store.js";
import { frontMatterTools, skillFolderPath, skillVersion } from "./runtime/capabilities/capabilities.js";
import { skillVersionsOf } from "./ui/plugins-api.js";
import { storeSql, storeSqlOrNull } from "./impl/store/sql/store-sql.js";
import { checkPackGrants } from "./packs/pack-grants.js";
import { type Authored, type CaseVerdict, type SkillEvalAuthoring, type SkillEvalEngineDeps, type TriedCase, addSkillEvalCase, addSkillEvalSuite, caseFromRun, deleteSkillEvalSuite, editSkillEvalCase, renameSkillEvalSuite, runSkillEval, skillEvalReplay, tryCase } from "./runtime/index.js";

/** The most replays per case one run makes (`eval run --replays N`, design 06-measurement, repeats). */
export const MAX_REPLAYS = 10;
/** The class a skill-eval replay runs on when no --model is given; its judge runs on judgeClass of it. */
export const SKILL_EVAL_CLASS: ModelClass = "standard";
/** The role a replay runs as: no file or shell tools, no session, no writable path (skillEvalReplay). */
const REPLAY_ROLE = "implement";
/** The run kind a replay's passport is minted for: a kind the worker calls no tool for, so it names only the granted tools. */
const REPLAY_PASSPORT_KIND = "skill_eval";

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
  /** --replays: replays per case, a whole number from 1 to MAX_REPLAYS (absent: 1). */
  replays?: number | undefined;
  /** A previous version's folder hash (an `ext_skill_versions` row of the skill) to re-run (absent: the current version). */
  version?: string | undefined;
  /** --baseline: replay with no skill text and no skill folder, stored as `baseline:<folder hash>` (absent: the skill's run). */
  baseline?: boolean | undefined;
}

/** The stored run with its figures, or why nothing was run (and no run written). */
export type SkillEvalResult = { run: SkillEvalRun } | { refused: string };

/** What serves a replay's granted tools: the guarded broker the runner calls them through, and the run passports. */
export interface ReplayTools {
  /** The configured broker behind G2 (brokerGuard); its read-only tools are the ones a replay may be granted. */
  broker: ToolBroker;
  /** Each replay run mints its own passport here and drops it after the run. */
  passports: Pick<RunPassports, "begin" | "end">;
  /** The project key the passports name. */
  project: string;
}

/** The plugins a run calls, built only once the skill's suite and files are found. */
export interface SkillEvalPlugins {
  sandbox: Sandbox;
  /** The runner; when `tools` is set it was built with that guarded broker and the scanner, as work-item runs' is. */
  runner: AgentRunner;
  llm: LLMProvider;
  scanner: EgressScanner;
  /** Milliseconds of the configured Clock, for a replay's wall time; absent: no wall time is stored. */
  now?: () => number;
  /** The broker tools a replay may be granted; absent: none is served, and a skill naming a tool is errored `tool_not_served`. */
  tools?: ReplayTools;
  /** Stops what was started for these plugins (Identity's tick), after the run; absent: nothing to stop. */
  close?(): Promise<void>;
}

export interface SkillEvalWiring {
  store: Pick<SkillEvalStore, "listSkillEvalSuites" | "getSkillEvalRun" | "recordSkillEvalRunFigures" | "startSkillEvalRun" | "listSkillEvalCases" | "listSkillEvalReplays" | "recordSkillEvalReplay" | "finishSkillEvalRun" | "getSkillEvalCase" | "listSkillEvalRuns" | "listSkillVersions">;
  /** Where a relative skill folder resolves. */
  root: string;
  /** prompts/skill-judge.md, the yes/no and rubric judge's system prompt. */
  judgePrompt(): Promise<string>;
  /** prompts/skill-judge-pairwise.md, the pairwise judge's system prompt; absent: no pairwise judge (a pairwise check with a previous answer errors the case). */
  pairwisePrompt?(): Promise<string>;
  /** `tools`: the skill names a broker tool, so the broker is wanted (wiringOf builds it only then). */
  plugins(o?: { tools: boolean }): Promise<SkillEvalPlugins>;
  repo: { path: string; base_branch: string };
  deny_paths: readonly string[];
  timeout_ms: number;
  newId(): string;
  /** The `sandbox` plugin's name (wiringOf sets it): under `noop` a replay with tools or MCP servers is refused (`noop_tools_refused`). */
  sandbox_plugin?: string;
  /**
   * The approved pack MCP servers for the names a case gives (`pack:mcp_server:<name>`), or null when one is not
   * approved or `runs` (the runner runs MCP servers) is false. Absent: none is served.
   */
  mcpServers?(names: readonly string[], runs: boolean): Promise<readonly PackMcpServer[] | null>;
  /** The factory revision stored on each run (SF_CODE_VERSION); absent: `dev`, as the worker stamps runs. */
  factory_version?: string;
}

/**
 * The judge's version: the SHA-256 over both judge prompts (skill-judge.md, then skill-judge-pairwise.md, each with its
 * length first), so a run judged by another prompt is told apart; either file changing gives a new version.
 */
export function judgeVersion(judge: string, pairwise: string): string {
  const h = createHash("sha256");
  for (const p of [judge, pairwise]) h.update(`${Buffer.byteLength(p)}:`).update(p);
  return h.digest("hex");
}

/**
 * The previous answer of a case for a run on `skill_version`: the stored answer for that case from the newest run of
 * `skill` on another (known) skill version that holds one, a baseline run (`baseline:`) left out, its replay numbered 1 when it has one (else its replay
 * stored with no number). Reads the runs once and each run's replays at most once.
 */
export function previousAnswers(store: Pick<SkillEvalStore, "listSkillEvalRuns" | "listSkillEvalReplays">, skill: string, skill_version: string): (case_id: string) => Promise<string | null> {
  let runs: Promise<SkillEvalRun[]> | null = null;
  const replays = new Map<string, ReturnType<typeof store.listSkillEvalReplays>>();
  return async (case_id) => {
    runs ??= store.listSkillEvalRuns(skill).then((rs) => rs.filter((r) => r.skill_version !== null && r.skill_version !== skill_version && !r.skill_version.startsWith("baseline:")));
    for (const run of await runs) {
      if (!replays.has(run.id)) replays.set(run.id, store.listSkillEvalReplays(run.id));
      const ofCase = (await replays.get(run.id)!).filter((x) => x.case_id === case_id);
      const answer = (ofCase.find((x) => x.replay === 1) ?? ofCase.find((x) => x.replay == null))?.answer;
      if (typeof answer === "string") return answer;
    }
    return null;
  };
}

/**
 * The engine's store with the run's judge and factory versions added to its start (the suite version the store reads),
 * and its case list narrowed to `split` when one is given (a scratch run, design 07-self-improvement).
 */
function versionedStore(store: SkillEvalWiring["store"], v: { judge_version: string; factory_version: string }, split?: SkillEvalSplit): SkillEvalEngineDeps["store"] {
  return {
    // The engine passes the run's created_by as text; it is the request's user or agent ID.
    startSkillEvalRun: (r) => store.startSkillEvalRun({ ...r, created_by: r.created_by as UserId, skill_version: r.skill_version ?? null, ...v }),
    listSkillEvalCases: async (id) => (await store.listSkillEvalCases(id)).filter((c) => split === undefined || c.split === split),
    listSkillEvalReplays: (id) => store.listSkillEvalReplays(id),
    recordSkillEvalReplay: (r) => store.recordSkillEvalReplay(r),
    finishSkillEvalRun: (id, status) => store.finishSkillEvalRun(id, status),
  };
}

/** A run's figures from its verdicts: replays (cases × N), pass verdicts ÷ replays (null with none), errored replays. */
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
  if (r.replays !== undefined && !(Number.isInteger(r.replays) && r.replays >= 1 && r.replays <= MAX_REPLAYS)) {
    return { refused: `--replays ${r.replays}: a whole number from 1 to ${MAX_REPLAYS}: nothing run` };
  }
  return { model_class };
}

/** The rule names `scanner` matched in `text`; none when it is clean. */
export async function scanRules(scanner: EgressScanner, text: string): Promise<string[]> {
  const r = await scanner.scan("log", text);
  return r.clean ? [] : r.findings.map((f) => f.rule);
}

/**
 * `runner` with each run holding its own run passport (RunPassports, audience tool-broker), narrowed to the run's
 * `tool_grants`, minted before the run and dropped after it: the guarded broker refuses a call from a run with none.
 */
function passportedRunner(runner: AgentRunner, t: ReplayTools): Pick<AgentRunner, "run"> {
  return {
    run: async (spec) => {
      const held = { run: spec.run_id, lease_token: spec.lease_token };
      await t.passports.begin({ ...held, kind: REPLAY_PASSPORT_KIND, item: spec.work_item_id, project: t.project, branch: `skill-eval/${spec.run_id}`, grants: spec.tool_grants });
      try {
        return await runner.run(spec);
      } finally {
        t.passports.end(held.run, held.lease_token);
      }
    },
  };
}

/**
 * The engine's replay (with `system_prompt` as the SKILL.md under test of `skill`, a skill folder), judge and scan on
 * `model_class`. When the skill's `tools:` front matter names a tool (and the sandbox is not `noop`, which refuses it),
 * the plugins are built with the configured broker behind G2: its read-only tools go to skillEvalReplay as
 * `broker_tools`, and each replay run holds a run passport narrowed to its granted tools. A named tool the broker does
 * not serve read-only still errors the case `tool_not_served`. A replay run holds no `worker_runs` lease, so a real
 * broker answers its tool call `lease_lost` until the follow-up "replay lease rule" (a broker lease rule for replay
 * runs, filed as its own issue) lands. With `baseline` the replay gets no skill: `system_prompt` is empty, no skill
 * folder is copied and no tool is named; the case's MCP servers apply as for the skill's run.
 */
async function engineOf(d: SkillEvalWiring, skill: string, system_prompt: string, model_class: ModelClass, skill_version: string, baseline = false): Promise<Engine> {
  const named = !baseline && frontMatterTools(system_prompt).length > 0 && d.sandbox_plugin !== "noop";
  const [p, system, pairwise] = await Promise.all([d.plugins({ tools: named }), d.judgePrompt(), d.pairwisePrompt?.() ?? null]);
  const folder = skillFolderPath(skill, d.root);
  const mcpServers = d.mcpServers;
  const t = named ? p.tools : undefined;
  const replay = skillEvalReplay({ sandbox: p.sandbox, runner: t ? passportedRunner(p.runner, t) : p.runner }, {
    repo: d.repo, role: REPLAY_ROLE, system_prompt, env_allowlist: {}, deny_paths: d.deny_paths, model_class, timeout_ms: d.timeout_ms,
    ...(baseline ? {} : { skill: { folder, name: basename(folder) } }), root: d.root, ...(d.sandbox_plugin !== undefined ? { sandbox_plugin: d.sandbox_plugin } : {}),
    ...(t ? { broker_tools: t.broker.allTools().filter((x) => x.read_only).map((x) => ({ name: x.name, read_only: true })) } : {}),
    ...(mcpServers ? { mcpServers: (names: readonly string[]) => mcpServers(names, p.runner.runs_mcp_servers === true) } : {}),
    ...(p.now ? { now: p.now } : {}),
  });
  const scan = (text: string) => scanRules(p.scanner, text);
  return {
    replay, judge: skillJudge(p.llm, system, model_class), rubric: skillRubricJudge(p.llm, system, model_class),
    ...(pairwise !== null ? { pairwise: skillPairwiseJudge(p.llm, pairwise, model_class) } : {}),
    previous: previousAnswers(d.store, skill, skill_version), scan, judge_version: judgeVersion(system, pairwise ?? ""), close: async () => p.close?.(),
  };
}

/** The engine's replay, judge and scan, the judge's version a run stores, and the stop of what its plugins started. */
type Engine = Omit<SkillEvalEngineDeps, "store"> & { judge_version: string; close(): Promise<void> };

/** The engine's parts for `skill`'s SKILL.md as it is now on `model_class`, or why they cannot be built (its SKILL.md is unreadable). */
async function engineParts(d: SkillEvalWiring, skill: string, model_class: ModelClass): Promise<{ engine: Engine; skill_version: string } | { refused: string }> {
  const folder = skillFolderPath(skill, d.root);
  const [skill_text, skill_version] = await Promise.all([readFile(join(folder, "SKILL.md"), "utf8").catch(() => null), skillVersion(folder).catch(() => null)]);
  if (skill_text === null || skill_version === null) return { refused: `cannot read ${skill}/SKILL.md: nothing run` };
  return { engine: await engineOf(d, skill, skill_text, model_class, skill_version), skill_version };
}

/**
 * The engine's parts for a baseline run of `skill` (no skill text, no skill folder) on `model_class`, stored as
 * `baseline:<folder hash>` with the folder's version now; refused when the folder cannot be read.
 */
async function baselineParts(d: SkillEvalWiring, skill: string, model_class: ModelClass): Promise<{ engine: Engine; skill_version: string } | { refused: string }> {
  const hash = await skillVersion(skillFolderPath(skill, d.root)).catch(() => null);
  if (hash === null) return { refused: `cannot read the folder of ${skill}: nothing run` };
  const skill_version = baselineVersion(hash);
  return { engine: await engineOf(d, skill, "", model_class, skill_version, true), skill_version };
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
  return { engine: await engineOf(d, skill, v.text, model_class, v.folder_hash), skill_version: v.folder_hash };
}

/** Runs the suite (only its `split` cases when given) through the engine as run `id`, records its figures and returns the stored run. */
async function runAndRecord(
  d: SkillEvalWiring, engine: Engine, r: { id: string; suite_id: string; created_by: string; skill_version: string; model_class: ModelClass; replays?: number; split?: SkillEvalSplit }, signal: AbortSignal,
): Promise<SkillEvalRun> {
  const { judge_version, close, ...parts } = engine;
  const store = versionedStore(d.store, { judge_version, factory_version: d.factory_version ?? "dev" }, r.split);
  const input = { id: r.id, suite_id: r.suite_id, created_by: r.created_by, skill_version: r.skill_version, ...(r.replays !== undefined ? { replays: r.replays } : {}) };
  const outcome = await runSkillEval({ store, ...parts }, input, signal).finally(close);
  if (outcome.status !== null) await d.store.recordSkillEvalRunFigures(r.id, runFigures(r.model_class, outcome.verdicts));
  const run = await d.store.getSkillEvalRun(r.id);
  if (!run) throw new Error(`skill eval run ${r.id} was not stored`);
  return run;
}

/**
 * Runs one skill eval of `r.skill`'s suite (its first, by creation) on its current version, or on `r.version`, then
 * records the run's figures. Refuses, naming the skill and writing no run, when no suite exists for it, its folder's
 * SKILL.md cannot be read, `r.version` is no version of it, `r.baseline` is given with `r.version`, and on an option
 * runClass refuses. With `r.baseline` it runs the suite with no skill (baselineParts).
 */
export async function runSkillEvalFor(d: SkillEvalWiring, r: SkillEvalRequest): Promise<SkillEvalResult> {
  const chosen = runClass(r);
  if ("refused" in chosen) return chosen;
  const { model_class } = chosen;
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill);
  if (!suite) return { refused: `no skill eval suite for ${r.skill}: nothing run` };
  if (r.baseline === true && r.version !== undefined) return { refused: `a baseline run replays no skill version: nothing run` };
  const parts = r.baseline === true ? await baselineParts(d, r.skill, model_class)
    : r.version === undefined ? await engineParts(d, r.skill, model_class) : await versionParts(d, r.skill, r.version, model_class);
  if ("refused" in parts) return parts;
  const run = await runAndRecord(d, parts.engine, {
    id: d.newId(), suite_id: suite.id, created_by: r.created_by, skill_version: parts.skill_version, model_class, ...(r.replays !== undefined ? { replays: r.replays } : {}),
  }, r.signal);
  return { run };
}

/**
 * A scratch run (design 07-self-improvement): only the `split` cases of `skill`'s suite (`dev` to measure a draft,
 * `held-out` for the check before a promotion) replayed with `system_prompt` as the skill's system prompt instead of
 * its SKILL.md, judged, stored under `skill_version` with its figures, which count those cases only. Reads no skill
 * file and writes none. Null when the skill has no suite.
 */
export async function scratchRunFor(
  d: SkillEvalWiring, r: { skill_ref: string; system_prompt: string; run_id: string; skill_version: string; model_class: ModelClass; created_by: UserId; split: SkillEvalSplit }, signal: AbortSignal,
): Promise<SkillEvalRun | null> {
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill_ref);
  if (!suite) return null;
  const run = { id: r.run_id, suite_id: suite.id, created_by: r.created_by, skill_version: r.skill_version, model_class: r.model_class, split: r.split };
  return runAndRecord(d, await engineOf(d, r.skill_ref, r.system_prompt, r.model_class, r.skill_version), run, signal);
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

/**
 * The gate pass's wiring over `d` (SkillGateWiring): an imported skill's suite is the one whose skill_ref resolves to
 * the folder of its SKILL.md (`refPath`, null for an unknown ref), and a gate run is `eval run` on the stored version.
 */
export function gateWiring(d: SkillEvalWiring, refPath: (ref_id: string) => Promise<string | null>): SkillGateWiring {
  return {
    newToken: d.newId,
    suiteOf: async (ref_id) => {
      const path = await refPath(ref_id);
      if (path === null) return null;
      const folder = resolve(dirname(path));
      return (await d.store.listSkillEvalSuites()).find((s) => resolve(skillFolderPath(s.skill_ref, d.root)) === folder)?.skill_ref ?? null;
    },
    run: async (r, signal) => {
      const res = await runSkillEvalFor(d, { skill: r.skill_ref, version: r.folder_hash, replays: r.replays, model_class: r.model_class, created_by: r.created_by, signal });
      return "run" in res ? res.run : null;
    },
  };
}

/** What `gatedImport` hands the import's store step: the configured store (migrated), its Clock and egress scanner. */
export interface GatedImportPlugins {
  store: FactoryStore;
  clock: { now(): Date };
  scanner: EgressScanner;
}

/**
 * `factory plugins import`'s storage over the configured plugins (src/import/import-plugins.ts): opens the store
 * (migrated) with the configured clock and scanner, runs `step`, then one new-version gate pass over the store's due
 * gates (`refPath`: the SKILL.md path of a ref, from step's result), and closes the store. Kept in the composition
 * root so the import engine imports no plugin set.
 */
export async function gatedImport<T>(
  loaded: Loaded, step: (p: GatedImportPlugins) => Promise<{ result: T; refPath: (ref_id: string) => Promise<string | null> }>,
): Promise<T> {
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const scanner = await p.scanner(secrets);
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const store = await p.store(secrets, clock);
  try {
    await store.migrate();
    const { result, refPath } = await step({ store, clock, scanner });
    const signal = new AbortController().signal;
    await runSkillVersionGates({ store, scanner, clock, wiring: gateWiring(wiringOf(store, loaded), refPath), signal });
    return result;
  } finally {
    await store.close();
  }
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
  const { judge_version: _unused, close, ...engine } = parts.engine;
  return tryCase({ store: d.store, ...engine }, r.case_id, r.signal).finally(close);
}

/**
 * The worker's skill improvement wiring (WorkerDeps.skillImprove) over its own plugins; undefined when
 * capabilities.skill_folders is absent or empty: then the improve run drafts no skill and asks nothing.
 */
export function skillImproveWiring(store: FactoryStore, loaded: Loaded, plugins: SkillEvalPlugins): SkillImproveWiring | undefined {
  const folders = capabilitiesConfig(loaded.file).skill_folders;
  if (folders.length === 0) return undefined;
  const prompt = () => readFile(join(loaded.codeRoot, "prompts", "skill-improve.md"), "utf8").catch(() => null);
  // The composition root passes no clock: a replay's wall time reads the configured Clock, as wiringOf's plugins do.
  const withClock = async (): Promise<SkillEvalPlugins> => {
    if (plugins.now) return plugins;
    const clock = await new Plugins(loaded).clock();
    return { ...plugins, now: () => clock.now().getTime() };
  };
  return improveWiring({ ...wiringOf(store, loaded), plugins: withClock }, skillImproveConfig(loaded.file), folders.map((f) => skillFolderPath(f, loaded.root)), prompt);
}

/**
 * The approved pack MCP servers named `names` in `db`'s pack entries (checkPackGrants), or null when one is not
 * approved or not started (`runs` false: the runner runs none).
 */
async function approvedMcpServers(db: NonNullable<ReturnType<typeof storeSqlOrNull>>, loaded: Loaded, names: readonly string[], runs: boolean): Promise<PackMcpServer[] | null> {
  const r = await checkPackGrants(db, names.map((n) => `pack:mcp_server:${n}`), loaded.config.packs_auto_approve_read_only === true, runs);
  return r.refused.length > 0 || r.broker.length > 0 ? null : r.mcp_servers;
}

/** G2 (RFC 0015 §8, M9; pack tool approvals #592): this process's run passports, and the guard every served broker sits behind. */
export interface BrokerGuard {
  passports: RunPassports;
  /** `b` behind the pack tool approvals and the run passport check (PassportToolBroker). */
  guard(b: ToolBroker): ToolBroker;
}

/**
 * The one G2 guard (build() for work-item runs, replayTools for skill-eval replays): pack tool approvals, then the
 * run passport check against `identity`, over the run passports this process holds.
 */
export function brokerGuard(loaded: Loaded, d: { store: FactoryStore; secrets: SecretStore; identity: PassportService; tool_grants: ToolGrants | undefined }): BrokerGuard {
  const packTools = packToolBrokers(loaded.pack_tools, d.tool_grants, { db: storeSql(d.store), store: d.store, secrets: d.secrets, autoApproveReadOnly: loaded.config.packs_auto_approve_read_only === true });
  const passports = new RunPassports(d.identity);
  return { passports, guard: (b) => new PassportToolBroker(packTools(b), { checker: d.identity, passportOf: (run) => passports.passportOf(run) }) };
}

/**
 * The configured broker through the registry, behind brokerGuard, with Identity started on the store for the replays'
 * run passports; `close` stops Identity. The passports name the stored project key, else the local one.
 */
async function replayTools(store: FactoryStore, loaded: Loaded, p: Plugins, d: { secrets: SecretStore; scanner: EgressScanner; clock: Awaited<ReturnType<Plugins["clock"]>> }): Promise<{ tools: ReplayTools; close(): Promise<void> }> {
  const { credentials, api: github } = await p.githubAccess(d);
  const broker = await createPlugin(loaded.registry, "broker", loaded.plugins.broker, { ...p.base, github, credentials, store, ...d });
  const tool_grants = toolGrantsConfig(loaded.file.tool_grants, broker, loaded.plugins.broker);
  const project = (await storeProjectResolver(store, loaded.config.repo)()) ?? localProject(loaded.config.repo);
  const identity = await startIdentity({ db: storeSql(store), stateDir: loaded.stateDir });
  const { guard, passports } = brokerGuard(loaded, { store, secrets: d.secrets, identity: identity.passports, tool_grants });
  return { tools: { broker: guard(broker), passports, project: project.key }, close: () => identity.stop() };
}

/** The configured plugins and wiring over `store`, as `skillEvalRun` and `skillEvalTry` build them. */
function wiringOf(store: FactoryStore, loaded: Loaded): SkillEvalWiring {
  const db = storeSqlOrNull(store);
  const plugins = async (o?: { tools: boolean }): Promise<SkillEvalPlugins> => {
    const p = new Plugins(loaded);
    const secrets = await p.secrets();
    const [sandbox, clock] = await Promise.all([p.sandbox(), p.clock()]);
    const scanner = await p.scanner(secrets);
    // The broker only for a skill that names a tool, and only over a SQL store, where Identity keeps its passports.
    const served = o?.tools === true && db ? await replayTools(store, loaded, p, { secrets, scanner, clock }) : null;
    try {
      const runner = await p.runner(sandbox, secrets, served ? { broker: served.tools.broker, scanner } : undefined);
      return { sandbox, runner, llm: await p.llm(secrets), scanner, now: () => clock.now().getTime(), ...(served ? { tools: served.tools, close: served.close } : {}) };
    } catch (e) {
      await served?.close();
      throw e;
    }
  };
  return {
    store, root: loaded.root, plugins, sandbox_plugin: loaded.plugins.sandbox,
    ...(db ? { mcpServers: (names: readonly string[], runs: boolean) => approvedMcpServers(db, loaded, names, runs) } : {}), judgePrompt: () => readFile(join(loaded.codeRoot, "prompts", "skill-judge.md"), "utf8"),
    pairwisePrompt: () => readFile(join(loaded.codeRoot, "prompts", "skill-judge-pairwise.md"), "utf8"),
    repo: loaded.config.repo, deny_paths: loaded.config.deny_paths, timeout_ms: loaded.config.run_timeout_ms, newId: () => randomUUID(),
    ...(() => { const v = codeVersion(process.env[CODE_VERSION_ENV]).code_version; return v ? { factory_version: v } : {}; })(),
  };
}

/** `factory eval run <skill>` over the configured plugins and `store` (CommandCall.runSkillEval, built by main.ts). */
export function skillEvalRun(store: FactoryStore, loaded: Loaded, r: SkillEvalRequest): Promise<SkillEvalResult> {
  return runSkillEvalFor(wiringOf(store, loaded), r);
}

/** `factory eval case try <case>` over the configured plugins and `store` (CommandCall.trySkillEvalCase, built by main.ts). */
export function skillEvalTry(store: FactoryStore, loaded: Loaded, r: SkillEvalTryRequest): Promise<Authored<TriedCase>> {
  return tryCaseFor(wiringOf(store, loaded), r);
}

/** The suite and case authoring calls with this wiring's ids (CommandCall.authoring, built by main.ts). */
export const skillEvalAuthoring: SkillEvalAuthoring = {
  addSuite: (store, r) => addSkillEvalSuite({ store, newId: () => randomUUID() }, r),
  renameSuite: renameSkillEvalSuite,
  deleteSuite: deleteSkillEvalSuite,
  addCase: (store, skill, f) => addSkillEvalCase({ store, newId: () => randomUUID() }, skill, f),
  editCase: editSkillEvalCase,
  caseFromRun,
};
