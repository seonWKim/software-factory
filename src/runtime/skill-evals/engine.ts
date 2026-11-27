// The skill-eval engine: one run of a suite replays each case N times (design 06-measurement, repeats), runs the case's
// checks on each replay (check and pass rules: checks.ts), records one verdict per replay with its number (1 to N) and
// sets the run's final status. Deterministic checks run
// first, with no model call; a failed must-have one fails the case and no judge is called. Then the judge answers the
// yes/no checks, scores the rubric criteria 1 to 5 and answers each pairwise check twice with the order swapped. The
// replay and the judges are injected: skillEvalReplay over replayInSandbox (the replay golden uses too) and the skill
// judges in src/core/scorer.ts (the plain completion LlmJudge uses too). Each replay runs in a clean sandbox (design
// 06-measurement, clean replays): the checkout without its CLAUDE.md, AGENTS.md and skill folders, the skill under test
// in `.claude/skills/<name>/`, the case's seed folder, the tools the skill's `tools:` front matter names and the MCP
// servers the case names. Its transcript, answer, usage and wall time are stored with its verdict; a flagged transcript
// or answer is stored null.
//
// Safe to run twice: the run is started by its id, a (case, replay number) with a stored verdict is not replayed again
// (a verdict stored with no number counts as replay 1), and the final status is set once. The store and result types are structural (the SkillEvalStore and AgentRunner shapes used
// here), so this component imports no legacy module (tests/architecture/dependency-direction.test.ts).

import { frontMatterTools, skillFolderPath } from "../capabilities/capabilities.js";
import {
  type CaseChecks, type Check, type CheckResult, type PairwiseJudgeFn, type RubricJudgeFn, type YesNoAnswer,
  caseScore, caseVerdict, checkLabel, isDeterministic, parseCaseChecks, reaches, runDeterministic, rubricValue,
} from "./checks.js";
import { type ReplayMcpServer, type ReplayRequest, type ReplayRunner, type ReplaySandbox, cleanSkillSandbox, replayInSandbox } from "./replay.js";

/** A case's verdict: `pass` when every must-have check passes and the score reaches the threshold, `errored` when unjudged. */
export type CaseVerdict = "pass" | "fail" | "errored";
export type RunStatus = "passed" | "failed" | "errored";

/** One yes/no check's answer, as the judge gives it. */
export type CheckAnswer = YesNoAnswer;

/** The SkillEvalStore calls the engine makes. */
export interface SkillEvalEngineStore {
  startSkillEvalRun(r: { id: string; suite_id: string; created_by: string; skill_version?: string | null }): Promise<{ status: string }>;
  listSkillEvalCases(suite_id: string): Promise<readonly EngineCase[]>;
  listSkillEvalReplays(run_id: string): Promise<readonly { case_id: string; verdict: string; replay?: number | null }[]>;
  recordSkillEvalReplay(r: { run_id: string; case_id: string; verdict: string; detail: unknown; replay: number } & Partial<ReplayRecord>): Promise<unknown>;
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
/** One answer per yes/no check, in order; null when the judge could not answer. */
export type SkillJudgeFn = (s: { input: string; output: string; checks: readonly string[] }, signal: AbortSignal) => Promise<readonly CheckAnswer[] | null>;

export interface SkillEvalEngineDeps {
  store: SkillEvalEngineStore;
  replay: SkillReplay;
  /** Answers the yes/no checks (the case's check texts). */
  judge: SkillJudgeFn;
  /** Scores the rubric criteria; absent: a case with a rubric criterion is errored `judge_failed`. */
  rubric?: RubricJudgeFn;
  /** Answers a pairwise check; absent: a case with a pairwise check and a previous answer is errored `judge_failed`. */
  pairwise?: PairwiseJudgeFn;
  /** The previous answer of a case: the stored one from the newest run on another skill version; null or absent: none. */
  previous?(case_id: string): Promise<string | null>;
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
  /** Replays per case (`eval run --replays N`, checked by the caller); absent: 1. */
  replays?: number;
}

export interface SkillEvalOutcome {
  run_id: string;
  /** Null when the run had already finished before this call: nothing was replayed. */
  status: RunStatus | null;
  /** One per stored replay: N per case once the run finished. */
  verdicts: { case_id: string; verdict: CaseVerdict }[];
}

/** A case's checks and threshold from its `expected` (checks.ts parseCaseChecks); null when it holds none. */
export function rubricChecks(expected: unknown): CaseChecks | null {
  const r = parseCaseChecks(expected);
  return "value" in r ? r.value : null;
}

/** A case's input as the replay's prompt: text as it is, any other value as JSON. */
const caseInput = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input));

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

/** What the checks read: the case's input, the replay's output, the case id (for its previous answer) and its checks. */
interface Checked extends CaseChecks {
  input: string;
  output: string;
  case_id: string;
}

const LEFT_OUT = "no previous answer to compare: left out of the score";
const base = (c: Check) => ({ check: checkLabel(c), kind: c.kind, weight: c.weight, must: c.must });
const yesNo = (c: Check, a: CheckAnswer): CheckResult => ({ ...base(c), answer: a.answer, reason: a.reason, value: a.answer === "yes" ? 1 : 0 });
const validScore = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;

/** The judges' results for the checks at `at` (by kind), set in `out`; false when a judge could not answer. */
async function judged(d: Omit<SkillEvalEngineDeps, "store">, s: Checked, out: CheckResult[], signal: AbortSignal): Promise<boolean> {
  const at = (kind: Check["kind"]) => s.checks.flatMap((c, i) => (c.kind === kind ? [i] : []));
  const asked = at("yes/no");
  if (asked.length > 0) {
    const a = await d.judge({ input: s.input, output: s.output, checks: asked.map((i) => checkLabel(s.checks[i]!)) }, signal).catch(() => null);
    if (!a || a.length !== asked.length) return false;
    asked.forEach((i, j) => (out[i] = yesNo(s.checks[i]!, a[j]!)));
  }
  const scored = at("rubric");
  if (scored.length > 0) {
    const criteria = scored.map((i) => s.checks[i] as Extract<Check, { kind: "rubric" }>).map((c) => ({ criterion: c.criterion, anchors: c.anchors }));
    const a = d.rubric ? await d.rubric({ input: s.input, output: s.output, criteria }, signal).catch(() => null) : null;
    if (!a || a.length !== scored.length || !a.every((x) => validScore(x.score))) return false;
    scored.forEach((i, j) => {
      const value = rubricValue(a[j]!.score);
      out[i] = { ...base(s.checks[i]!), answer: reaches(value, s.threshold) ? "yes" : "no", reason: a[j]!.reason, score: a[j]!.score, value };
    });
  }
  const paired = at("pairwise");
  const previous = paired.length > 0 ? ((await d.previous?.(s.case_id).catch(() => null)) ?? null) : null;
  for (const i of paired) {
    const c = s.checks[i] as Extract<Check, { kind: "pairwise" }>;
    if (previous === null) {
      out[i] = { ...base(c), answer: "yes", reason: LEFT_OUT, value: null };
      continue;
    }
    if (!d.pairwise) return false;
    const ask = (a: string, b: string, candidate: "A" | "B") => d.pairwise!({ input: s.input, criterion: c.criterion, a, b, candidate }, signal).catch(() => null);
    const first = await ask(s.output, previous, "A");
    const second = first && (await ask(previous, s.output, "B"));
    if (!first || !second) return false;
    const win = first.answer === "yes" && second.answer === "yes";
    out[i] = { ...base(c), answer: win ? "yes" : "no", reason: `new first: ${first.answer}, ${first.reason} New second: ${second.answer}, ${second.reason}`, value: win ? 1 : 0 };
  }
  return true;
}

/**
 * Runs a case's checks on its output: the deterministic ones first, with no model call; a failed must-have one ends
 * it there (`judged` false, no judge called). Null when a judge could not answer.
 */
async function checkResults(d: Omit<SkillEvalEngineDeps, "store">, s: Checked, signal: AbortSignal): Promise<{ results: CheckResult[]; judged: boolean } | null> {
  const out: CheckResult[] = [];
  s.checks.forEach((c, i) => {
    if (!isDeterministic(c)) return;
    const r = runDeterministic(c, s.output);
    out[i] = { ...base(c), answer: r.pass ? "yes" : "no", reason: r.reason, value: r.pass ? 1 : 0 };
  });
  if (out.some((r) => r?.must && r.answer === "no")) return { results: out.filter((r) => r !== undefined), judged: false };
  return (await judged(d, s, out, signal)) ? { results: out, judged: true } : null;
}

/** Replays and checks one case; never throws for the replay's or a judge's fault. */
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
  const r = await checkResults(d, { ...checks, input, output: replayed.output, case_id: c.id }, signal);
  if (!r) return { verdict: "errored", detail: { error: "judge_failed", ...withheld }, ...stored };
  const answers = await Promise.all(r.results.map(async (x) => ({ ...x, reason: (await d.scan(x.reason)).length === 0 ? x.reason : "(withheld by the egress scan)" })));
  const verdict = r.judged ? caseVerdict(r.results, checks.threshold) : "fail";
  return { verdict, detail: { answers, score: r.judged ? caseScore(r.results) : null, threshold: checks.threshold, ...withheld }, ...stored };
}

/** A (case, replay number) key; a replay stored with no number is replay 1. */
const replayKey = (case_id: string, replay: number | null | undefined) => JSON.stringify([case_id, replay ?? 1]);

/**
 * Runs one skill eval: starts the run with its skill version, replays and judges each case `r.replays` times (each
 * round over every case before the next), skipping a (case, replay number) already recorded, records one verdict per
 * replay with its number, and sets the run's final status (runStatus). A run that is already finished is left as it is.
 */
export async function runSkillEval(d: SkillEvalEngineDeps, r: SkillEvalRunInput, signal: AbortSignal): Promise<SkillEvalOutcome> {
  const run = await d.store.startSkillEvalRun({ id: r.id, suite_id: r.suite_id, created_by: r.created_by, skill_version: r.skill_version });
  const listed = () => d.store.listSkillEvalReplays(r.id);
  const stored = async () => (await listed()).map((x) => ({ case_id: x.case_id, verdict: x.verdict as CaseVerdict }));
  if (run.status !== "running") return { run_id: r.id, status: null, verdicts: await stored() };
  const done = new Set((await listed()).map((x) => replayKey(x.case_id, x.replay)));
  const cases = await d.store.listSkillEvalCases(r.suite_id);
  for (let replay = 1; replay <= (r.replays ?? 1); replay++) {
    for (const c of cases) {
      if (done.has(replayKey(c.id, replay))) continue;
      if (signal.aborted) return { run_id: r.id, status: null, verdicts: await stored() };
      const { verdict, detail, record } = await judgeCase(d, r.id, c, signal);
      await d.store.recordSkillEvalReplay({ run_id: r.id, case_id: c.id, replay, verdict, detail, ...record });
    }
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

/**
 * What a skill-eval replay runs with: the skill's text as the system prompt, the skill, and the repo, class and limits.
 * With no `skill` it is a baseline replay (design 07-self-improvement): no skill folder, no SKILL.md and no tools from
 * front matter; the case's seed folder and MCP servers still apply.
 */
export type SkillReplayOptions<T> = Omit<ReplayRequest<T>, "run_id" | "work_item_id" | "prompt" | "tools" | "tool_grants" | "mcp_servers" | "prepare" | "output_schema" | "signal"> & {
  skill?: SkillUnderTest;
  /** The `sandbox` plugin's name: under `noop` a replay with tools or MCP servers is refused (`noop_tools_refused`). Absent: not noop. */
  sandbox_plugin?: string;
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
  const tool_grants = o.skill ? frontMatterTools(o.system_prompt) : [];
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
 * (cleanSkillSandbox: no CLAUDE.md, AGENTS.md or other skill, the skill in `.claude/skills/<name>/` unless it is a
 * baseline replay, the case's seed), with the tools the skill's `tools:` front matter names (none when absent), the MCP servers the case names
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
    const under = skill ? { skill: { name: skill.name, folder: skill.folder, text: o.system_prompt } } : {};
    const prepare = (h: H) => cleanSkillSandbox(parts.sandbox, h, { ...under, ...(seed_folder ? { seed_folder } : {}) }, signal);
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
