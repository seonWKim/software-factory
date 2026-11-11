import { type Grade, type GradeSubject, improvePrompts, learnFromReport, runImprove, scoreRun, scorerFor } from "../../../core/improver.js";
import { withMessageStyle } from "../../../core/message-style.js";
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
  const metered = meteredLlm(w, run);
  const report = await runImprove(
    {
      store: w.d.store, storage: w.d.storage, scanner: w.d.scanner, signal,
      ...(metered ? { llm: metered } : {}), ...(w.d.prompts.improve !== undefined ? { prompt: draftPrompt(w, w.d.prompts.improve) } : {}),
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

/** The improve draft's system prompt with the owner's `message_style` after it, read live (design 04-agents); the scorer's prompt never takes it. */
export function draftPrompt(w: Pick<Worker, "live">, improve: string): string {
  return withMessageStyle(improvePrompts(improve).draft, w.live.values().message_style);
}

/** The worker's LLMProvider with each call's usage added to the run's (design §6); absent when it has none. */
function meteredLlm(w: Worker, run: Run): LLMProvider | undefined {
  const { llm } = w.d;
  const meter = w.meters.get(run);
  return llm && {
    complete: async (req) => {
      const res = await llm.complete(req);
      if (meter) addUsage(meter, res.usage);
      return res;
    },
  };
}

/**
 * A succeeded agent run's data with its scorer grades (design §7, issue #514), from judges independent of the call
 * that produced it (src/core/scorer.ts); their usage counts toward the run's. No model class (a kind with no agent),
 * no LLMProvider or no scorer prompt: the data as it was, with no grade. Grading never fails the run.
 */
export async function gradeRun(
  w: Worker, run: Run, item: WorkItem, producer: GradeSubject["producer"] | null, data: Record<string, unknown>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (producer === null) return data;
  const scorer = scorerFor(meteredLlm(w, run), w.d.prompts.improve);
  const grades: Grade[] = await scoreRun({ scorer, scanner: w.d.scanner, signal }, { kind: run.kind, title: item.title ?? "", producer, data })
    .catch(() => []);
  return grades.length > 0 ? { ...data, grades } : data;
}

export default defineRunKind({
  name: "improve",
  folder: false,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => improve(w, c.run, c.item, c.signal),
});
