// The skill-eval engine: one run of a suite replays each case, has the judge answer each of the case's rubric checks
// yes or no, records one verdict per case and sets the run's final status. The replay and the judge are injected:
// skillEvalReplay over replayInSandbox (the replay golden uses too) and skillJudge in src/core/scorer.ts (the plain
// completion LlmJudge uses too). Each replay runs in a clean sandbox (design 06-measurement, clean replays): the
// checkout without its CLAUDE.md, AGENTS.md and skill folders, the skill under test in `.claude/skills/<name>/`, the
// case's seed folder, the tools the skill's `tools:` front matter names and the MCP servers the case names. Its
// transcript, answer, usage and wall time are stored with its verdict; a flagged transcript or answer is stored null.
//
// Safe to run twice: the run is started by its id, a case with a stored verdict is not replayed again, and the final
// status is set once. The store and result types are structural (the SkillEvalStore and AgentRunner shapes used
// here), so this component imports no legacy module (tests/architecture/dependency-direction.test.ts).

import { frontMatterTools, skillFolderPath } from "../capabilities/capabilities.js";
import { type ReplayMcpServer, type ReplayRequest, type ReplayRunner, type ReplaySandbox, cleanSkillSandbox, replayInSandbox } from "./replay.js";

/** A case's verdict: `pass` when the judge answered yes to every check, `fail` on one no, `errored` when unjudged. */
export type CaseVerdict = "pass" | "fail" | "errored";
export type RunStatus = "passed" | "failed" | "errored";

/** One rubric check's answer, as the judge gives it. */
export interface CheckAnswer {
  answer: "yes" | "no";
  reason: string;
}

/** The SkillEvalStore calls the engine makes. */
export interface SkillEvalEngineStore {
  startSkillEvalRun(r: { id: string; suite_id: string; created_by: string; skill_version?: string | null }): Promise<{ status: string }>;
  listSkillEvalCases(suite_id: string): Promise<readonly EngineCase[]>;
  listSkillEvalReplays(run_id: string): Promise<readonly { case_id: string; verdict: string }[]>;
  recordSkillEvalReplay(r: { run_id: string; case_id: string; verdict: string; detail: unknown } & Partial<ReplayRecord>): Promise<unknown>;
  finishSkillEvalRun(id: string, status: RunStatus): Promise<boolean>;
}

/** A stored case as the engine reads it: its seed folder and MCP server names when it names them. */
export interface EngineCase {
  id: string;
  input: unknown;
  expected: unknown;
  seed?: string | null;
  mcp?: readonly string[] | null;
}

/** One case to replay: its input as text, the run it belongs to, and its seed folder and MCP servers (absent: none). */
export interface ReplayCase {
  run_id: string;
  case_id: string;
  input: string;
  seed?: string | null;
  mcp?: readonly string[] | null;
}

/** What a replay stores beside its verdict (design 06-measurement); null where it has no value or the scan flagged it. */
export interface ReplayRecord {
  transcript: string | null;
  answer: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Null when the runner reports no cost. */
  cost_usd: number | null;
  wall_ms: number | null;
}

/** A replay's output: the text the judge reads, and what it stores (before the scan); absent: nothing but the verdict. */
export interface ReplayOutput {
  output: string;
  record?: ReplayRecord;
}

/** Replays one case; throws when the replay did not complete (a ReplayRefused names why it never started). */
export type SkillReplay = (c: ReplayCase, signal: AbortSignal) => Promise<ReplayOutput>;

/** A replay refused before any sandbox is made: `code` is the case's error (`noop_tools_refused`, `tool_not_served`, `mcp_not_served`). */
export class ReplayRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
/** One answer per check, in order; null when the judge could not answer. */
export type SkillJudgeFn = (s: { input: string; output: string; checks: readonly string[] }, signal: AbortSignal) => Promise<readonly CheckAnswer[] | null>;

export interface SkillEvalEngineDeps {
  store: SkillEvalEngineStore;
  replay: SkillReplay;
  judge: SkillJudgeFn;
  /** The G5 egress scan of text before the store keeps it: the rule names it matched, none when clean. */
  scan(text: string): Promise<readonly string[]>;
}

export interface SkillEvalRunInput {
  id: string;
  suite_id: string;
  /** A user or agent ID, never a display name. */
  created_by: string;
  /**
   * The folder hash of the skill version the run replays (capabilities skillVersion): the folder's now, or a stored
   * version's on a re-run (src/skill-evals.ts). It links the run to that `ext_skill_versions` row (design 06-measurement).
   */
  skill_version: string;
}

export interface SkillEvalOutcome {
  run_id: string;
  /** Null when the run had already finished before this call: nothing was replayed. */
  status: RunStatus | null;
  verdicts: { case_id: string; verdict: CaseVerdict }[];
}

/** A case's rubric checks: `expected` as a list of check texts, or `{ checks: [...] }`; null when it is neither. */
export function rubricChecks(expected: unknown): string[] | null {
  const list = Array.isArray(expected) ? expected : typeof expected === "object" && expected !== null ? (expected as { checks?: unknown }).checks : null;
  if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === "string" && c.trim() !== "")) return null;
  return list as string[];
}

/** A case's input as the replay's prompt: text as it is, any other value as JSON. */
const caseInput = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input));

/** `pass` only when every answer is yes; one no fails the case. */
const verdictOf = (answers: readonly CheckAnswer[]): CaseVerdict => (answers.every((a) => a.answer === "yes") ? "pass" : "fail");

/** The run's status from its verdicts: `failed` on one failed case, else `errored` on one errored case or none at all, else `passed`. */
function runStatus(verdicts: readonly string[]): RunStatus {
  if (verdicts.includes("fail")) return "failed";
  return verdicts.length === 0 || verdicts.some((v) => v !== "pass") ? "errored" : "passed";
}

/**
 * The record as the store may keep it: a transcript or answer the scan flags becomes null, and the rule names it
 * matched (never the text) go into `withheld`, by field.
 */
async function scannedRecord(scan: SkillEvalEngineDeps["scan"], r: ReplayRecord): Promise<{ record: ReplayRecord; withheld: Record<string, string[]> }> {
  const withheld: Record<string, string[]> = {};
  const kept = async (field: "transcript" | "answer") => {
    const text = r[field];
    if (text === null) return null;
    const rules = [...new Set(await scan(text))];
    if (rules.length === 0) return text;
    withheld[field] = rules;
    return null;
  };
  return { record: { ...r, transcript: await kept("transcript"), answer: await kept("answer") }, withheld };
}

/** A judged case: its verdict, its detail, and what its replay stores (absent: nothing). */
export interface JudgedCase {
  verdict: CaseVerdict;
  detail: unknown;
  record?: ReplayRecord;
}

/** Replays and judges one case; never throws for the replay's or the judge's fault. */
export async function judgeCase(d: Omit<SkillEvalEngineDeps, "store">, run_id: string, c: EngineCase, signal: AbortSignal): Promise<JudgedCase> {
  const checks = rubricChecks(c.expected);
  if (!checks) return { verdict: "errored", detail: { error: "no_rubric" } };
  const input = caseInput(c.input);
  let replayed: ReplayOutput;
  try {
    replayed = await d.replay({ run_id, case_id: c.id, input, seed: c.seed ?? null, mcp: c.mcp ?? null }, signal);
  } catch (e) {
    return { verdict: "errored", detail: { error: e instanceof ReplayRefused ? e.code : "replay_failed" } };
  }
  const scanned = replayed.record ? await scannedRecord(d.scan, replayed.record) : null;
  const stored = scanned ? { record: scanned.record } : {};
  const withheld = scanned && Object.keys(scanned.withheld).length > 0 ? { withheld: scanned.withheld } : {};
  const answers = await d.judge({ input, output: replayed.output, checks }, signal).catch(() => null);
  if (!answers || answers.length !== checks.length) return { verdict: "errored", detail: { error: "judge_failed", ...withheld }, ...stored };
  const kept = await Promise.all(answers.map(async (a, i) => ({ check: checks[i]!, answer: a.answer, reason: (await d.scan(a.reason)).length === 0 ? a.reason : "(withheld by the egress scan)" })));
  return { verdict: verdictOf(answers), detail: { answers: kept, ...withheld }, ...stored };
}

/**
 * Runs one skill eval: starts the run with its skill version, replays and judges each case not yet recorded, records
 * one verdict per case, and sets the run's final status (runStatus). A run that is already finished is left as it is.
 */
export async function runSkillEval(d: SkillEvalEngineDeps, r: SkillEvalRunInput, signal: AbortSignal): Promise<SkillEvalOutcome> {
  const run = await d.store.startSkillEvalRun({ id: r.id, suite_id: r.suite_id, created_by: r.created_by, skill_version: r.skill_version });
  const stored = async () => (await d.store.listSkillEvalReplays(r.id)).map((x) => ({ case_id: x.case_id, verdict: x.verdict as CaseVerdict }));
  if (run.status !== "running") return { run_id: r.id, status: null, verdicts: await stored() };
  const done = new Set((await stored()).map((x) => x.case_id));
  for (const c of await d.store.listSkillEvalCases(r.suite_id)) {
    if (done.has(c.id)) continue;
    if (signal.aborted) return { run_id: r.id, status: null, verdicts: await stored() };
    const { verdict, detail, record } = await judgeCase(d, r.id, c, signal);
    await d.store.recordSkillEvalReplay({ run_id: r.id, case_id: c.id, verdict, detail, ...record });
  }
  const verdicts = await stored();
  const status = runStatus(verdicts.map((v) => v.verdict));
  await d.store.finishSkillEvalRun(r.id, status);
  return { run_id: r.id, status, verdicts };
}

/** The skill a replay tests: its folder (copied to `.claude/skills/<name>/`, `name` its last part) and the SKILL.md text under test. */
export interface SkillUnderTest {
  folder: string;
  name: string;
}

/** What a skill-eval replay runs with: the skill's text as the system prompt, the skill, and the repo, class and limits. */
export type SkillReplayOptions<T> = Omit<ReplayRequest<T>, "run_id" | "work_item_id" | "prompt" | "tools" | "tool_grants" | "mcp_servers" | "prepare" | "output_schema" | "signal"> & {
  skill: SkillUnderTest;
  /** The `sandbox` plugin's name: under `noop` a replay with tools or MCP servers is refused (`noop_tools_refused`). */
  sandbox_plugin: string;
  /** The tools the ToolBroker serves; only a read-only one may be granted. Absent: none. */
  broker_tools?: readonly { name: string; read_only: boolean }[];
  /** The approved MCP servers for the names a case gives, or null when one is not served. Absent: none is. */
  mcpServers?(names: readonly string[]): Promise<readonly ReplayMcpServer[] | null>;
  /** Where a case's relative seed folder resolves. */
  root: string;
  /** Milliseconds of the injected clock, for the replay's wall time; absent: no wall time. */
  now?: () => number;
};

/** The tools and MCP servers a replay gets, or why it is refused; checked before any sandbox is made. */
async function grantsOf<T>(o: SkillReplayOptions<T>, c: ReplayCase): Promise<{ tool_grants: string[]; mcp_servers?: readonly ReplayMcpServer[] }> {
  const tool_grants = frontMatterTools(o.system_prompt);
  const names = c.mcp ?? [];
  if ((tool_grants.length > 0 || names.length > 0) && o.sandbox_plugin === "noop") {
    throw new ReplayRefused("noop_tools_refused", "the noop sandbox runs no replay with tools or MCP servers");
  }
  const served = new Set((o.broker_tools ?? []).filter((t) => t.read_only).map((t) => t.name));
  const missing = tool_grants.filter((t) => !served.has(t));
  if (missing.length > 0) throw new ReplayRefused("tool_not_served", `the ToolBroker serves no read-only tool ${missing.join(", ")}`);
  if (names.length === 0) return { tool_grants };
  const mcp_servers = (await o.mcpServers?.(names)) ?? null;
  if (mcp_servers === null) throw new ReplayRefused("mcp_not_served", `no approved MCP server for ${names.join(", ")}`);
  return { tool_grants, mcp_servers };
}

/** The final answer as text: as it is, JSON for a structured one, null for none. */
const answerText = (output: unknown): string | null => (typeof output === "string" ? output : output != null ? JSON.stringify(output) : null);

/**
 * The skill-eval replay over replayInSandbox: each case runs in a fresh sandbox, cleaned before the agent starts
 * (cleanSkillSandbox: no CLAUDE.md, AGENTS.md or other skill, the skill in `.claude/skills/<name>/`, the case's
 * seed), with the tools the skill's `tools:` front matter names (none when absent), the MCP servers the case names
 * (none when it names none), no session and no doc index, the sandbox destroyed after. A replay with tools under
 * the noop sandbox, or one naming a tool or server that is not served, is refused before any sandbox is made. Its
 * output is the final answer as text, else its transcript; its record holds both, the usage and the wall time. A
 * run that does not complete throws, and its case is errored.
 */
export function skillEvalReplay<H, T, R extends { status: string; output: unknown; transcript: string; usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } }>(
  parts: { sandbox: ReplaySandbox<H>; runner: ReplayRunner<H, T, R> },
  o: SkillReplayOptions<T>,
): SkillReplay {
  const { skill, sandbox_plugin: _s, broker_tools: _b, mcpServers: _m, root, now, ...request } = o;
  return async (c, signal) => {
    const grants = await grantsOf(o, c);
    const seed_folder = c.seed ? skillFolderPath(c.seed, root) : undefined;
    const prepare = (h: H) => cleanSkillSandbox(parts.sandbox, h, { skill_name: skill.name, skill_folder: skill.folder, skill_text: o.system_prompt, ...(seed_folder ? { seed_folder } : {}) }, signal);
    const started = now?.();
    const result = await replayInSandbox(parts, { ...request, ...grants, prepare, run_id: `skill_eval_${c.run_id}_${c.case_id}`, work_item_id: `skill_eval_${c.run_id}`, prompt: c.input, signal });
    if (result.status !== "completed") throw new Error(`skill-eval replay ${result.status}`);
    const answer = answerText(result.output);
    return {
      output: answer ?? result.transcript,
      record: {
        transcript: result.transcript, answer, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
        cost_usd: result.usage.cost_usd ?? null, wall_ms: started === undefined || !now ? null : now() - started,
      },
    };
  };
}
