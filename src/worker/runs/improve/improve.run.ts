import { learnFromReport, runImprove } from "../../../core/improver.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { LLMProvider } from "../../../interfaces/llm-provider.js";
import { addUsage } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind } from "../../run-kind.js";

/**
 * The improve run (design §7): no sandbox, no agent. One plain model call per group, with no tools; its usage
 * counts toward the run's. Stores one report; the outcome names it. Then, only in the daily run and only from the
 * stored report, the learner may write one tighter max_diff_lines for the project (design 08-settings).
 */
async function improve(w: Worker, run: Run, item: WorkItem, signal: AbortSignal): Promise<Record<string, unknown>> {
  const { llm } = w.d;
  const meter = w.meters.get(run);
  const metered: LLMProvider | undefined = llm && {
    complete: async (req) => {
      const res = await llm.complete(req);
      if (meter) addUsage(meter, res.usage);
      return res;
    },
  };
  const report = await runImprove(
    {
      store: w.d.store, storage: w.d.storage, scanner: w.d.scanner, signal,
      ...(metered ? { llm: metered } : {}), ...(w.d.prompts.improve !== undefined ? { prompt: w.d.prompts.improve } : {}),
    },
    run,
    item,
  );
  const learned = await learnFromReport({ store: w.d.store, layers: w.cfg.settings }, run, report);
  return {
    report_id: report.id, groups: report.groups.length, patterns: report.patterns.length,
    ...(learned ? { learned: { key: learned.key, old_value: learned.old_value, new_value: learned.new_value } } : {}),
  };
}

export default defineRunKind({
  name: "improve",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => improve(w, c.run, c.item, c.signal),
});
