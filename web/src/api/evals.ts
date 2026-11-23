// The evals page's reads (design 06-measurement, 09-dashboard-evals): GET /api/v1/evals/<skill>/runs, /grid and
// /compare?a=&b=, the same fields as the CLI's --json, and Run now's POST /api/v1/evals/<skill>/runs. <skill> is the
// skill_ref, URL-encoded. A null figure means none was recorded, never 0.

import { useQuery } from "@tanstack/react-query";
import { getJson, postJson, useApi } from "./client.js";

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

/** The skill_refs that have a suite (GET /api/v1/evals); read once when the page opens, never polled. */
export const useEvalSuites = () => useApi<{ skills: string[] }>("/api/v1/evals", false);

/** Run now's options, as `factory eval run`'s flags: the model class as stored (never a model ID), its judge class, replays. */
export interface EvalRunOptions {
  model_class: string;
  judge_model_class: string;
  replays: number;
}

/**
 * Run now: POST /api/v1/evals/<skill>/runs, which runs the suite once and answers when the run is stored. The run's ID
 * and status, or the server's reason (403 for the owner check, 409 for a refused run), null when it gave none.
 */
export async function postEvalRun(token: string, skill: string, o: EvalRunOptions): Promise<{ ok: true; run_id: string; status: string } | { ok: false; error: string | null }> {
  const r = await postJson<{ run_id?: string; status?: string; error?: string }>(base(skill, "runs"), token, o);
  if (r.ok && r.value.run_id !== undefined && r.value.status !== undefined) return { ok: true, run_id: r.value.run_id, status: r.value.status };
  return { ok: false, error: r.value.error ?? null };
}
