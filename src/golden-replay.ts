// The improve run's golden replay of the review cases (design 07-improve-report, entity proposals, issue #496). Built in
// the composition root and handed to the worker as WorkerDeps.reviewReplay, so the improve run kind imports neither
// golden.ts nor the runtime (RFC 0023 R1: a feature imports only kernel and its own engine).

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewReplay, WorkerDeps } from "./core/worker-deps.js";
import { runCases } from "./golden.js";
import { loadRoles } from "./runtime/index.js";

/**
 * Each call is one replay of the review cases (runCases, unchanged) with `prompt` as the reviewer's system prompt, held
 * in memory: no file is written but the results file, under the OS temp folder, one folder per replay.
 */
export function reviewReplay(d: Pick<WorkerDeps, "sandbox" | "runner" | "scanner" | "clock" | "models">): ReviewReplay {
  let n = 0;
  return async (prompt, { run_id, config, signal }) => {
    const r = await runCases({
      rolesDir: join(import.meta.dirname, "worker", "roles"), roles: await loadRoles(), prompt: async () => prompt,
      resultsDir: join(tmpdir(), "software-factory-golden", run_id, String(n++)), sandbox: d.sandbox, runner: d.runner, scanner: d.scanner,
      clock: d.clock, config, signal, ...(d.models ? { model_by: d.models.table } : {}),
    }, { role: "review", prompts: ["review.md"] });
    return { cases: r.cases.map(({ id, expect, verdict }) => ({ id, expect, verdict })), catch_rate: r.rates.catch_rate.value, false_alarm_rate: r.rates.false_alarm_rate.value };
  };
}
