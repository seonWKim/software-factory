// Skill evals on the local API (design 06-measurement). GET /api/v1/evals/<skill>/runs lists the skill's stored runs,
// newest first, with the same fields as `factory eval results <skill> --json` (FactoryStore.listSkillEvalRuns): the
// run, its skill version and its figures, null where none was recorded. <skill> is the suite's skill_ref,
// URL-encoded (it holds a slash). Read-only: no run starts here and nothing is written. Every stored string leaves
// through the Withholder.

import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type ApiResult, apiError } from "./api.js";
import { Withholder } from "./withhold.js";

/** /api/v1/evals/<skill>/runs, with the URL-encoded skill_ref as its one group. */
export const EVALS_RUNS_PATH = /^\/api\/v1\/evals\/([^/]+)\/runs$/;

export async function readSkillEvalRuns(d: { store: Pick<FactoryStore, "listSkillEvalRuns">; scanner: EgressScanner }, pathname: string): Promise<ApiResult> {
  const encoded = EVALS_RUNS_PATH.exec(pathname)?.[1];
  let skill: string;
  try {
    skill = decodeURIComponent(encoded ?? "");
  } catch {
    return apiError(400, "The skill is not a URL-encoded skill_ref.");
  }
  if (skill === "") return apiError(404, "Not found.");
  const w = new Withholder(d.scanner);
  const runs = await Promise.all((await d.store.listSkillEvalRuns(skill)).map(async (r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === "string" ? (await w.plain(v)).text : v;
    return out;
  }));
  return { status: 200, value: { runs } };
}
