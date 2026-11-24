// Authoring skill-eval suites and cases (design 06-measurement): the rules the `factory eval suite` and `eval case`
// commands share. One suite per skill; a case's `expected` must be rubric check texts (rubricChecks, the engine's
// rule), or nothing is written; a suite is deleted only while none of its runs is running, and its runs stay in the
// store. `tryCase` replays and judges one case through the engine's judgeCase and stores nothing. The store type is
// structural (the SkillEvalStore calls used here), so this component imports no legacy module.

import { type CaseVerdict, type SkillEvalEngineDeps, judgeCase, rubricChecks } from "./engine.js";
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

const NOT_RUBRIC = 'expected must be a list of rubric check texts, or {"checks": [...]}: nothing written';

/** The suite of `skill` (its first, by creation: the one `eval run` runs). */
async function suiteOf(store: Pick<SkillEvalAuthoringStore, "listSkillEvalSuites">, skill: string): Promise<AuthoredSuite | null> {
  return (await store.listSkillEvalSuites()).find((s) => s.skill_ref === skill) ?? null;
}

/** Whether `f` is a whole case: an input and an expected value that is a rubric. Names the problem, else null. */
export function validateCase(f: CaseFields): string | null {
  if (f.input === undefined) return "a case needs an input: nothing written";
  return f.expected !== undefined && rubricChecks(f.expected) !== null ? null : NOT_RUBRIC;
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
  /** One line per check; empty when the case errored. */
  checks: { check: string; answer: "yes" | "no"; reason: string }[];
  /** Why it errored (`no_rubric`, `replay_failed`, `judge_failed`, or a refusal: `noop_tools_refused`, `tool_not_served`, `mcp_not_served`), else null. */
  error: string | null;
}

/** Replays and judges one case through the engine's judgeCase (judge reasons pass the egress scan); writes nothing. */
export async function tryCase(d: Omit<SkillEvalEngineDeps, "store"> & { store: Pick<SkillEvalAuthoringStore, "getSkillEvalCase"> }, id: string, signal: AbortSignal): Promise<Authored<TriedCase>> {
  const c = await d.store.getSkillEvalCase(id);
  if (!c) return { refused: `no skill eval case ${id}` };
  const { verdict, detail } = await judgeCase(d, `try_${id}`, c, signal);
  const { answers, error } = detail as { answers?: TriedCase["checks"]; error?: string };
  return { value: { verdict, checks: answers ?? [], error: error ?? null } };
}

/** The authoring calls the CLI makes, with ids already bound (src/skill-evals.ts skillEvalAuthoring). */
export interface SkillEvalAuthoring {
  addSuite(store: SkillEvalAuthoringStore, r: { skill: string; title?: string; created_by: string }): Promise<Authored<AuthoredSuite>>;
  renameSuite(store: SkillEvalAuthoringStore, skill: string, title: string): Promise<Authored<AuthoredSuite>>;
  deleteSuite(store: SkillEvalAuthoringStore, skill: string, announce: (runs: number) => void): Promise<Authored<{ runs: number }>>;
  addCase(store: SkillEvalAuthoringStore, skill: string, f: CaseFields): Promise<Authored<AuthoredCase>>;
  editCase(store: SkillEvalAuthoringStore, id: string, f: CaseFields): Promise<Authored<AuthoredCase>>;
  /** `eval import` over the configured SkillEvalSource and egress scanner (import.ts, wired by main.ts); absent: it refuses. */
  importCases?(store: SkillEvalImportStore, r: SkillEvalImportRequest): Promise<Authored<ImportedCases>>;
}
