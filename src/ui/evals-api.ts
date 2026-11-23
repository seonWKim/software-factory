// Skill evals on the local API (design 06-measurement), each with the same fields as its CLI --json:
// - GET /api/v1/evals/<skill>/runs: the skill's stored runs, newest first (`factory eval results <skill> --json`,
//   FactoryStore.listSkillEvalRuns), null where a figure was not recorded.
// - GET /api/v1/evals/<skill>/grid: one row per skill version and model class from its newest run
//   (`factory eval results <skill> --by version,model --json`, skillEvalGrid).
// - GET /api/v1/evals/<skill>/compare?a=<run-a>&b=<run-b>: the two runs, the gap, the noise band and within_noise
//   (`factory eval compare <run-a> <run-b> --json`, compareSkillEvalRuns); 404 when a run is unknown or of another skill.
// <skill> is the suite's skill_ref, URL-encoded (it holds a slash). Read-only: no run starts here and nothing is
// written. Every stored string leaves through the Withholder. The grid and compare functions come from the route
// table (read-routes.ts, the root), as main.ts passes them to the CLI, so this feature has no runtime import of core.

import type { compareSkillEvalRuns, skillEvalGrid } from "../core/skill-eval-compare.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type ApiResult, apiError } from "./api.js";
import { Withholder } from "./withhold.js";

/** /api/v1/evals/<skill>/<read>, with the URL-encoded skill_ref and the read as its groups. */
export const EVALS_PATH = /^\/api\/v1\/evals\/([^/]+)\/(runs|grid|compare)$/;

type EvalsDeps = { store: Pick<FactoryStore, "listSkillEvalRuns" | "getSkillEvalRun" | "listSkillEvalSuites">; scanner: EgressScanner };
/** src/core/skill-eval-compare.ts's grid and compare, the same functions the CLI is given. */
export interface SkillEvalReads {
  grid: typeof skillEvalGrid;
  compare: typeof compareSkillEvalRuns;
}

/** `value` with every string in it (nested too) through the Withholder. */
async function withheld(w: Withholder, value: unknown): Promise<unknown> {
  if (typeof value === "string") return (await w.plain(value)).text;
  if (Array.isArray(value)) return Promise.all(value.map((v) => withheld(w, v)));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = await withheld(w, v);
  return out;
}

/** Answers one GET under /api/v1/evals/<skill>/ (EVALS_PATH). */
export async function readSkillEvals(d: EvalsDeps, reads: SkillEvalReads, url: URL): Promise<ApiResult> {
  const [, encoded, read] = EVALS_PATH.exec(url.pathname) ?? [];
  let skill: string;
  try {
    skill = decodeURIComponent(encoded ?? "");
  } catch {
    return apiError(400, "The skill is not a URL-encoded skill_ref.");
  }
  if (skill === "") return apiError(404, "Not found.");
  const w = new Withholder(d.scanner);
  if (read === "runs") return { status: 200, value: { runs: await withheld(w, await d.store.listSkillEvalRuns(skill)) } };
  if (read === "grid") return { status: 200, value: { rows: await withheld(w, reads.grid(await d.store.listSkillEvalRuns(skill))) } };
  const a = url.searchParams.get("a"), b = url.searchParams.get("b");
  if (!a || !b) return apiError(400, "Name both runs: ?a=<run-a>&b=<run-b>.");
  const [ra, rb, suites] = await Promise.all([d.store.getSkillEvalRun(a), d.store.getSkillEvalRun(b), d.store.listSkillEvalSuites()]);
  const ofSkill = new Set(suites.filter((s) => s.skill_ref === skill).map((s) => s.id));
  if (!ra || !rb || !ofSkill.has(ra.suite_id) || !ofSkill.has(rb.suite_id)) return apiError(404, "No such eval run for this skill.");
  return { status: 200, value: await withheld(w, reads.compare(ra, rb)) };
}
