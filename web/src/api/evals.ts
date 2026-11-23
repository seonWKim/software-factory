// The evals page's reads (design 06-measurement, 09-dashboard-evals): GET /api/v1/evals/<skill>/runs, /grid and
// /compare?a=&b=, the same fields as the CLI's --json. <skill> is the skill_ref, URL-encoded. A null figure means none
// was recorded, never 0. The Plugins page's Evals card (design 09-dashboard-settings) also reads /suite and writes
// through POST /api/v1/evals/write (postEvalWrite), with GET /api/v1/pauses's csrf_token.

import { useQuery } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { getJson, postJson, useApi } from "./client.js";
import { API } from "./routes.js";
import type { PausesView } from "./supervisor.js";

/** A skill's stored run (FactoryStore.listSkillEvalRuns), newest first in the list. */
export interface EvalRun {
  id: string;
  /** The suite the run replayed; absent from an older server. */
  suite_id?: string;
  status: string;
  started_at: string;
  skill_version: string | null;
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/** One run as the grid and compare show it. */
export interface EvalRunSummary extends Omit<EvalRun, "id"> {
  run_id: string;
}

/** Two runs, b − a, the noise band and whether the gap is inside it; all three null without two pass rates. */
export interface EvalComparison {
  a: EvalRunSummary;
  b: EvalRunSummary;
  gap: number | null;
  noise_band: number | null;
  within_noise: boolean | null;
}

const base = (skill: string, read: "runs" | "grid" | "compare" | "suite"): string => `/api/v1/evals/${encodeURIComponent(skill)}/${read}`;

/** Read again every 30 seconds while the page is open. */
const POLL_MS = 30_000;

/** The skill's runs, newest first. */
export const useEvalRuns = (skill: string) => useApi<{ runs: EvalRun[] }>(base(skill, "runs"), POLL_MS);

/** One row per skill version and model class: that pair's newest run. */
export const useEvalGrid = (skill: string) => useApi<{ rows: EvalRunSummary[] }>(base(skill, "grid"), POLL_MS);

/** Two runs of the skill compared; reads nothing until both are picked. */
export function useEvalCompare(skill: string, a: string | null, b: string | null) {
  const url = a && b ? `${base(skill, "compare")}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` : null;
  return useQuery({ queryKey: [url], queryFn: () => getJson<EvalComparison>(url!), enabled: url !== null });
}

/** The skill_refs that have a suite (GET /api/v1/evals); read once when the page opens, never polled. */
export const useEvalSuites = () => useApi<{ skills: string[] }>("/api/v1/evals", false);

/** A skill's eval suite: one per skill. */
export interface EvalSuite {
  id: string;
  skill_ref: string;
  title: string;
}

/** One test case: what the skill is given, and the rubric checks its answer must meet (a list, or `{ checks }`). */
export interface EvalCase {
  id: string;
  suite_id: string;
  input: unknown;
  expected: unknown;
}

/** GET /api/v1/evals/<skill>/suite: the skill's suite, null when it has none, and its cases. */
export interface EvalSuiteView {
  suite: EvalSuite | null;
  cases: EvalCase[];
}

/** The skill's suite and cases; read when the card opens and after each write, never polled. */
export const useEvalSuite = (skill: string) => useApi<EvalSuiteView>(base(skill, "suite"), false);

/** The write token: GET /api/v1/pauses's csrf_token, null when the server has no write route. */
export const useEvalsToken = () => useApi<PausesView>(API.pauses, false);

/** One case tried once: its verdict and each check's answer; nothing is stored. */
export interface TriedCase {
  verdict: "pass" | "fail" | "errored";
  checks: { check: string; answer: "yes" | "no"; reason: string }[];
  error: string | null;
}

/** One op of POST /api/v1/evals/write (src/ui/evals-api.ts). */
export type EvalWrite =
  | { op: "suite.add"; skill: string; title?: string }
  | { op: "suite.rename"; skill: string; title: string }
  | { op: "suite.delete"; skill: string }
  | { op: "case.add"; skill: string; input: unknown; expected: unknown }
  | { op: "case.edit"; case: string; input?: unknown; expected?: unknown }
  | { op: "case.delete"; case: string }
  | { op: "case.try"; case: string }
  | { op: "import"; skill: string };

/** The answer's fields: `runs` after a suite delete, `tried` after a try, `added` and `kept` after an import. */
export interface EvalWritten {
  op: EvalWrite["op"];
  runs?: number;
  tried?: TriedCase;
  added?: string[];
  kept?: string[];
}

/** POST /api/v1/evals/write: the answer, or the server's reason (a 409 is a rule's refusal; nothing was written). */
export async function postEvalWrite(token: string, body: EvalWrite): Promise<{ ok: true; value: EvalWritten } | { ok: false; error: string }> {
  const r = await postJson<EvalWritten & { error?: string }>("/api/v1/evals/write", token, body);
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
