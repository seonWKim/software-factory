// The skill-eval engine: one run of a suite replays each case, has the judge answer each of the case's rubric checks
// yes or no, records one verdict per case and sets the run's final status. The replay and the judge are injected:
// skillEvalReplay over replayInSandbox (the replay golden uses too) and skillJudge in src/core/scorer.ts (the plain
// completion LlmJudge uses too). Nothing starts a run yet: no command, page or schedule calls runSkillEval.
//
// Safe to run twice: the run is started by its id, a case with a stored verdict is not replayed again, and the final
// status is set once. The store and result types are structural (the SkillEvalStore and AgentRunner shapes used
// here), so this component imports no legacy module (tests/architecture/dependency-direction.test.ts).

import { type ReplayRequest, type ReplayRunner, type ReplaySandbox, replayInSandbox } from "./replay.js";

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
  listSkillEvalCases(suite_id: string): Promise<readonly { id: string; input: unknown; expected: unknown }[]>;
  listSkillEvalReplays(run_id: string): Promise<readonly { case_id: string; verdict: string }[]>;
  recordSkillEvalReplay(r: { run_id: string; case_id: string; verdict: string; detail: unknown }): Promise<unknown>;
  finishSkillEvalRun(id: string, status: RunStatus): Promise<boolean>;
}

/** One case to replay: its input as text, and the run it belongs to. */
export interface ReplayCase {
  run_id: string;
  case_id: string;
  input: string;
}

/** Replays one case and returns the replay's output as text; throws when the replay did not complete. */
export type SkillReplay = (c: ReplayCase, signal: AbortSignal) => Promise<string>;
/** One answer per check, in order; null when the judge could not answer. */
export type SkillJudgeFn = (s: { input: string; output: string; checks: readonly string[] }, signal: AbortSignal) => Promise<readonly CheckAnswer[] | null>;

export interface SkillEvalEngineDeps {
  store: SkillEvalEngineStore;
  replay: SkillReplay;
  judge: SkillJudgeFn;
  /** The G5 egress scan of text before the store keeps it: true when clean. A flagged reason is withheld. */
  scan(text: string): Promise<boolean>;
}

export interface SkillEvalRunInput {
  id: string;
  suite_id: string;
  /** A user or agent ID, never a display name. */
  created_by: string;
  /** The skill folder's version (capabilities skillVersion) when the run starts. */
  skill_version: string;
}

export interface SkillEvalOutcome {
  run_id: string;
  /** Null when the run had already finished before this call: nothing was replayed. */
  status: RunStatus | null;
  verdicts: { case_id: string; verdict: CaseVerdict }[];
}

/** A case's rubric checks: `expected` as a list of check texts, or `{ checks: [...] }`; null when it is neither. */
function rubricChecks(expected: unknown): string[] | null {
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

/** Replays and judges one case; never throws for the replay's or the judge's fault. */
async function judgeCase(d: SkillEvalEngineDeps, run_id: string, c: { id: string; input: unknown; expected: unknown }, signal: AbortSignal): Promise<{ verdict: CaseVerdict; detail: unknown }> {
  const checks = rubricChecks(c.expected);
  if (!checks) return { verdict: "errored", detail: { error: "no_rubric" } };
  const input = caseInput(c.input);
  let output: string;
  try {
    output = await d.replay({ run_id, case_id: c.id, input }, signal);
  } catch {
    return { verdict: "errored", detail: { error: "replay_failed" } };
  }
  const answers = await d.judge({ input, output, checks }, signal).catch(() => null);
  if (!answers || answers.length !== checks.length) return { verdict: "errored", detail: { error: "judge_failed" } };
  const kept = await Promise.all(answers.map(async (a, i) => ({ check: checks[i]!, answer: a.answer, reason: (await d.scan(a.reason)) ? a.reason : "(withheld by the egress scan)" })));
  return { verdict: verdictOf(answers), detail: { answers: kept } };
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
    const { verdict, detail } = await judgeCase(d, r.id, c, signal);
    await d.store.recordSkillEvalReplay({ run_id: r.id, case_id: c.id, verdict, detail });
  }
  const verdicts = await stored();
  const status = runStatus(verdicts.map((v) => v.verdict));
  await d.store.finishSkillEvalRun(r.id, status);
  return { run_id: r.id, status, verdicts };
}

/** What a skill-eval replay runs with: the skill's text as the system prompt, and the repo, class and limits. */
export type SkillReplayOptions<T> = Omit<ReplayRequest<T>, "run_id" | "work_item_id" | "prompt" | "tools" | "output_schema" | "signal">;

/**
 * The skill-eval replay over replayInSandbox: each case runs in a fresh sandbox with no tools (`tools: []`), no
 * session and no doc index, the sandbox destroyed after. Its output is the run's final answer as text (JSON for a
 * structured one), else its transcript. A run that does not complete throws, and its case is errored.
 */
export function skillEvalReplay<H, T, R extends { status: string; output: unknown; transcript: string }>(
  parts: { sandbox: ReplaySandbox<H>; runner: ReplayRunner<H, T, R> },
  o: SkillReplayOptions<T>,
): SkillReplay {
  return async (c, signal) => {
    const result = await replayInSandbox(parts, { ...o, run_id: `skill_eval_${c.run_id}_${c.case_id}`, work_item_id: `skill_eval_${c.run_id}`, prompt: c.input, signal });
    if (result.status !== "completed") throw new Error(`skill-eval replay ${result.status}`);
    return typeof result.output === "string" ? result.output : result.output != null ? JSON.stringify(result.output) : result.transcript;
  };
}
