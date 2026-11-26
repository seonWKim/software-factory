// Authoring skill-eval suites and cases (design 06-measurement): the rules the `factory eval suite` and `eval case`
// commands share. One suite per skill; a case's `expected` must be checks the engine reads (checks.ts
// parseCaseChecks: check texts, or check objects of a known kind with a weight of 0 or more and, for a rubric, an anchor
// for each level 1 to 5), or nothing is written; a suite is deleted only while none of its runs is running, and its runs stay in the
// store. `tryCase` replays and judges one case through the engine's judgeCase and stores nothing. The store type is
// structural (the SkillEvalStore calls used here), so this component imports no legacy module.

import type { CheckResult } from "./checks.js";
import { parseCaseChecks } from "./checks.js";
import { type CaseVerdict, type SkillEvalEngineDeps, judgeCase } from "./engine.js";
import type { ImportedCases, SkillEvalImportRequest, SkillEvalImportStore } from "./import.js";

export interface AuthoredSuite { id: string; skill_ref: string; title: string }
export interface AuthoredCase { id: string; suite_id: string; input: unknown; expected: unknown }

/** The SkillEvalStore calls authoring makes. */
export interface SkillEvalAuthoringStore {
  createSkillEvalSuite(s: AuthoredSuite & { created_by: string }): Promise<AuthoredSuite>;
  listSkillEvalSuites(): Promise<readonly AuthoredSuite[]>;
  updateSkillEvalSuiteTitle(id: string, title: string): Promise<AuthoredSuite | null>;
  deleteSkillEvalSuite(id: string): Promise<"deleted" | "running" | "unknown">;
  addSkillEvalCase(c: AuthoredCase): Promise<AuthoredCase>;
  getSkillEvalCase(id: string): Promise<AuthoredCase | null>;
  updateSkillEvalCase(id: string, c: { input: unknown; expected: unknown }): Promise<AuthoredCase | null>;
  listSkillEvalRuns(skill_ref: string): Promise<readonly { suite_id: string; status: string }[]>;
}

/** A change that was made, or why nothing was written. */
export type Authored<T> = { value: T } | { refused: string };

/** A case's fields as given; a field left out keeps its value on an edit. */
export interface CaseFields { input?: unknown; expected?: unknown }

/** The suite of `skill` (its first, by creation: the one `eval run` runs). */
async function suiteOf(store: Pick<SkillEvalAuthoringStore, "listSkillEvalSuites">, skill: string): Promise<AuthoredSuite | null> {
  return (await store.listSkillEvalSuites()).find((s) => s.skill_ref === skill) ?? null;
}

/** Whether `f` is a whole case: an input and an expected value holding checks. Names the problem, else null. */
export function validateCase(f: CaseFields): string | null {
  if (f.input === undefined) return "a case needs an input: nothing written";
  const r = parseCaseChecks(f.expected);
  return "refused" in r ? `${r.refused}: nothing written` : null;
}

export async function addSkillEvalSuite(d: { store: SkillEvalAuthoringStore; newId(): string }, r: { skill: string; title?: string; created_by: string }): Promise<Authored<AuthoredSuite>> {
  if (await suiteOf(d.store, r.skill)) return { refused: `${r.skill} already has a suite: nothing written` };
  return { value: await d.store.createSkillEvalSuite({ id: d.newId(), skill_ref: r.skill, title: r.title ?? r.skill, created_by: r.created_by }) };
}

export async function renameSkillEvalSuite(store: SkillEvalAuthoringStore, skill: string, title: string): Promise<Authored<AuthoredSuite>> {
  const suite = await suiteOf(store, skill);
  const renamed = suite && (await store.updateSkillEvalSuiteTitle(suite.id, title));
  return renamed ? { value: renamed } : { refused: `no skill eval suite for ${skill}: nothing written` };
}

/** Deletes the skill's suite and its cases; `runs` is how many of its runs keep their history (the runs stay stored). */
export async function deleteSkillEvalSuite(store: SkillEvalAuthoringStore, skill: string, announce: (runs: number) => void): Promise<Authored<{ runs: number }>> {
  const suite = await suiteOf(store, skill);
  if (!suite) return { refused: `no skill eval suite for ${skill}: nothing deleted` };
  const runs = (await store.listSkillEvalRuns(skill)).filter((r) => r.suite_id === suite.id);
  if (runs.some((r) => r.status === "running")) return { refused: `${skill} has a run that is running: nothing deleted` };
  announce(runs.length);
  const outcome = await store.deleteSkillEvalSuite(suite.id);
  if (outcome === "running") return { refused: `${skill} has a run that is running: nothing deleted` };
  return outcome === "deleted" ? { value: { runs: runs.length } } : { refused: `no skill eval suite for ${skill}: nothing deleted` };
}

export async function addSkillEvalCase(d: { store: SkillEvalAuthoringStore; newId(): string }, skill: string, f: CaseFields): Promise<Authored<AuthoredCase>> {
  const suite = await suiteOf(d.store, skill);
  if (!suite) return { refused: `no skill eval suite for ${skill}: nothing written` };
  const bad = validateCase(f);
  if (bad) return { refused: bad };
  return { value: await d.store.addSkillEvalCase({ id: d.newId(), suite_id: suite.id, input: f.input, expected: f.expected }) };
}

export async function editSkillEvalCase(store: SkillEvalAuthoringStore, id: string, f: CaseFields): Promise<Authored<AuthoredCase>> {
  const stored = await store.getSkillEvalCase(id);
  if (!stored) return { refused: `no skill eval case ${id}: nothing written` };
  const merged = { input: f.input ?? stored.input, expected: f.expected ?? stored.expected };
  const bad = validateCase(merged);
  if (bad) return { refused: bad };
  const updated = await store.updateSkillEvalCase(id, merged);
  return updated ? { value: updated } : { refused: `no skill eval case ${id}: nothing written` };
}

export interface TriedCase {
  verdict: CaseVerdict;
  /** One line per check run (its kind, weight, must, value and rubric score as the detail stores them); empty when the case errored. */
  checks: (Pick<CheckResult, "check" | "answer" | "reason"> & Partial<CheckResult>)[];
  /** The case score (checks.ts caseScore) and the threshold it must reach; score null when unjudged, both absent when errored. */
  score?: number | null;
  threshold?: number;
  /** Why it errored (`no_rubric`, `replay_failed`, `judge_failed`, or a refusal: `noop_tools_refused`, `tool_not_served`, `mcp_not_served`), else null. */
  error: string | null;
}

/** A case as `case from-run` copies it: its seed and MCP servers, and the split the copy gets. */
export interface CopiedCase extends AuthoredCase { seed?: string | null; mcp?: readonly string[] | null; split?: "dev" | "held-out" }

/** The SkillEvalStore calls `caseFromRun` makes. */
export interface SkillEvalFromRunStore {
  listSkillEvalReplays(run_id: string): Promise<readonly { case_id: string; verdict: string }[]>;
  getSkillEvalCase(id: string): Promise<CopiedCase | null>;
  addSkillEvalCase(c: CopiedCase): Promise<AuthoredCase>;
}

/** The refusal of `caseFromRun`, with no run or case id so a page can show it as it is. */
const NO_FAILED_REPLAY = "That case has no failed replay in that run: nothing written.";

/** The id of the dev case added from `case_id` of `run_id`: one per run and case, so a repeat adds nothing. */
const fromRunCaseId = (run_id: string, case_id: string): string => `from-run:${run_id}:${case_id}`;

/**
 * `eval case from-run` and the write op `case.from_run` (design 07-self-improvement): a new `dev` case in the case's
 * suite copying its input, expected, seed and MCP servers, only when the case has a replay with verdict `fail` in the
 * run; else refused, nothing written. The new id is derived from the run and the case: a repeat returns the stored
 * case and writes nothing.
 */
export async function caseFromRun(store: SkillEvalFromRunStore, run_id: string, case_id: string): Promise<Authored<AuthoredCase>> {
  const [replays, c] = await Promise.all([store.listSkillEvalReplays(run_id), store.getSkillEvalCase(case_id)]);
  if (!c || !replays.some((r) => r.case_id === case_id && r.verdict === "fail")) return { refused: NO_FAILED_REPLAY };
  const id = fromRunCaseId(run_id, case_id);
  const stored = await store.getSkillEvalCase(id);
  if (stored) return { value: stored };
  return {
    value: await store.addSkillEvalCase({
      id, suite_id: c.suite_id, input: c.input, expected: c.expected, split: "dev", ...(c.seed != null ? { seed: c.seed } : {}), ...(c.mcp != null ? { mcp: c.mcp } : {}),
    }),
  };
}

/** Replays and checks one case through the engine's judgeCase (judge reasons pass the egress scan); writes nothing. */
export async function tryCase(d: Omit<SkillEvalEngineDeps, "store"> & { store: Pick<SkillEvalAuthoringStore, "getSkillEvalCase"> }, id: string, signal: AbortSignal): Promise<Authored<TriedCase>> {
  const c = await d.store.getSkillEvalCase(id);
  if (!c) return { refused: `no skill eval case ${id}` };
  const { verdict, detail } = await judgeCase(d, `try_${id}`, c, signal);
  const { answers, error, score, threshold } = detail as { answers?: TriedCase["checks"]; error?: string; score?: number | null; threshold?: number };
  return { value: { verdict, checks: answers ?? [], ...(threshold !== undefined ? { score: score ?? null, threshold } : {}), error: error ?? null } };
}

/** The authoring calls the CLI and the evals write route make, with ids already bound (src/skill-evals.ts skillEvalAuthoring). */
export interface SkillEvalAuthoring {
  addSuite(store: SkillEvalAuthoringStore, r: { skill: string; title?: string; created_by: string }): Promise<Authored<AuthoredSuite>>;
  renameSuite(store: SkillEvalAuthoringStore, skill: string, title: string): Promise<Authored<AuthoredSuite>>;
  deleteSuite(store: SkillEvalAuthoringStore, skill: string, announce: (runs: number) => void): Promise<Authored<{ runs: number }>>;
  addCase(store: SkillEvalAuthoringStore, skill: string, f: CaseFields): Promise<Authored<AuthoredCase>>;
  editCase(store: SkillEvalAuthoringStore, id: string, f: CaseFields): Promise<Authored<AuthoredCase>>;
  /** `eval case from-run` and the write op `case.from_run` (caseFromRun). */
  caseFromRun(store: SkillEvalFromRunStore, run_id: string, case_id: string): Promise<Authored<AuthoredCase>>;
  /** `eval import` over the configured SkillEvalSource and egress scanner (import.ts, wired by main.ts); absent: it refuses. */
  importCases?(store: SkillEvalImportStore, r: SkillEvalImportRequest): Promise<Authored<ImportedCases>>;
}
