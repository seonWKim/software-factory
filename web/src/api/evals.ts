// The evals page's reads (design 06-measurement, 09-dashboard-evals): GET /api/v1/evals/<skill>/runs, /grid and
// /compare?a=&b=, the same fields as the CLI's --json. <skill> is the skill_ref, URL-encoded. Read-only. A null figure
// means none was recorded, never 0.

import { useQuery } from "@tanstack/react-query";
import { getJson, useApi } from "./client.js";

/** A skill's stored run (FactoryStore.listSkillEvalRuns), newest first in the list. */
export interface EvalRun {
  id: string;
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

const base = (skill: string, read: "runs" | "grid" | "compare"): string => `/api/v1/evals/${encodeURIComponent(skill)}/${read}`;

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
