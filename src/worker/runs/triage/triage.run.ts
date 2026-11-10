import type { ModelClass } from "../../../core/model-choice.js";
import { TRIAGE_SCHEMA, parseTriage } from "../../../core/outputs.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import { RunFailure, renderRevision, renderWorkItem, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

/** The `parseTriage` refusal (issue #454) that earns one re-prompt (issue #488); any other refusal fails at once. */
const MARKUP_REFUSAL = ": tool-call markup outside code";

async function triage(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: ModelClass, step: RunCall["step"]) {
  // One journaled step: a takeover after it returns the stored spec.
  return step("run-agent", async () => {
    const prompt = item.revision_count > 0
      ? await w.withIndex(renderRevision(item), [item.issue_text ?? item.problem, item.spec_feedback ?? ""].join("\n"))
      : await w.withIndex(renderWorkItem(item, { includeSpec: false }), item.problem);
    const ask = (text: string, agentStep?: string) =>
      w.agent(run, item, handle, signal, { prompt: text, model_class: model, output_schema: TRIAGE_SCHEMA }, agentStep);
    let result = await ask(prompt);
    let spec = parseTriage(result.output);
    if (!spec.ok && spec.error.endsWith(MARKUP_REFUSAL)) {
      // One more call in the same step, naming the error; a second refusal fails the run with that error.
      result = await ask(
        `${prompt}\n\n## Your previous answer was refused\n\n${spec.error}\n\nNever write tool-call tags inside a field value. Answer with the JSON only.`,
        "markup-retry",
      );
      spec = parseTriage(result.output);
    }
    if (!spec.ok) throw new RunFailure("invalid_output", spec.error, false, { output_tail: tail(result.transcript) });
    return { spec: spec.value };
  });
}

export default defineRunKind({
  name: "triage",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => triage(w, c.run, c.item, c.handle!, c.signal, c.model, c.step),
});
