// Shared helpers for the evals UI test files (tests/ui-evals-*.test.tsx).

import type { EvalRun } from "../web/src/api/evals.js";

export const SLOW = { timeout: 5_000 };
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const run = (id: string, day: number, over: Partial<EvalRun> = {}): EvalRun => ({
  id, status: "passed", started_at: `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`, skill_version: "sha-old", model_class: "standard",
  judge_model_class: "cheap", replays: 20, pass_rate: 0.5, errored: 0, ...over,
});
