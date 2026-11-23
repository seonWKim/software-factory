// POST /api/v1/evals/<skill>/runs (design 06-measurement, 09-dashboard-evals): Run now, one skill-eval run started from
// the evals page, as `factory eval run <skill> --model <class> --judge-model <class> --replays <n>`. It runs after the
// request guards (write-routes.ts: Host, Origin, Content-Type, CSRF token, body size) and the owner check (rules-api.ts
// ownerOf: approve_spec, then the store's owner; passed in by the route table), whose refusal is a 403 with its reason. The run itself is UiEvals.run
// (src/skill-evals.ts skillEvalRun, wired by `factory ui`), whose option and suite checks refuse before anything is
// written: that refusal is a 409 with its reason and stores no run. The run starts as the acting user's ID (never a
// display name) and is logged with it; the answer is the run's ID and status only, each through the Withholder.
// <skill> is the suite's skill_ref, URL-encoded; the GET of the same path (evals-api.ts) is the runs read.

import type { Logger } from "../core/log.js";
import type { UserId } from "../core/types.js";
import { type ApiResult, apiError } from "./api.js";
import type { EvalsWriteDeps, UiEvals } from "./evals-api.js";
import { Withholder } from "./withhold.js";

/** /api/v1/evals/<skill>/runs, the URL-encoded skill_ref as its group. */
export const EVALS_RUNS_PATH = /^\/api\/v1\/evals\/([^/]+)\/runs$/;

/** The options a body may carry, each as `eval run`'s flag: --model, --judge-model, --replays. */
type RunOptions = { model_class?: string; judge_model_class?: string; replays?: number };

/** The body's options, or why it is malformed (the 400's text). runSkillEval judges their values. */
function optionsOf(body: unknown): RunOptions | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "The body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const out: RunOptions = {};
  for (const key of ["model_class", "judge_model_class"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "string" || b[key].trim() === "") return `${key} must be a model class, as stored (cheap, standard or strong).`;
    out[key] = b[key];
  }
  if (b.replays !== undefined) {
    if (typeof b.replays !== "number" || !Number.isInteger(b.replays)) return "replays must be a whole number.";
    out.replays = b.replays;
  }
  return out;
}

/** What a run needs, passed in by the route table (write-routes.ts): UiEvals.run, the owner check (rules-api.ts ownerOf) and the log. */
export interface EvalRunDeps {
  run: NonNullable<UiEvals["run"]>;
  owner: (does: string) => Promise<{ user: UserId } | { error: string }>;
  log: Logger;
}

/**
 * POST /api/v1/evals/<skill>/runs, after the request guards: one run through runSkillEval, owner only. `skill` is the
 * path's decoded skill_ref, or the answer for a path that has none (evals-api.ts skillOf).
 */
export async function postSkillEvalRun(d: Pick<EvalsWriteDeps, "store" | "scanner">, skill: string | ApiResult, body: unknown, c: EvalRunDeps): Promise<ApiResult> {
  if (typeof skill !== "string") return skill;
  const options = optionsOf(body);
  if (typeof options === "string") return apiError(400, options);
  const w = new Withholder(d.scanner);
  const own = await c.owner("starts a skill eval run");
  if ("error" in own) return apiError(403, (await w.plain(own.error)).text);
  const r = await c.run(d.store, { skill, created_by: own.user, signal: new AbortController().signal, ...options });
  if ("refused" in r) return apiError(409, (await w.plain(r.refused)).text);
  c.log.info("skill eval run", { run_id: r.run.id, status: r.run.status, actor: own.user });
  return { status: 200, value: { run_id: (await w.plain(r.run.id)).text, status: (await w.plain(r.run.status)).text } };
}
