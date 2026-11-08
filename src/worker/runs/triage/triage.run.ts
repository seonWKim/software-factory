import type { ModelClass } from "../../../core/model-choice.js";
import { TRIAGE_SCHEMA, parseTriage } from "../../../core/outputs.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import { READ_TOOLS, RunFailure, renderRevision, renderWorkItem, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, defineRunKind } from "../../run-kind.js";

async function triage(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: ModelClass) {
  const result = await w.agent(run, item, handle, signal, {
    system_prompt: w.d.prompts.triage,
    prompt: item.revision_count > 0
      ? await w.withIndex(renderRevision(item), [item.issue_text ?? item.problem, item.spec_feedback ?? ""].join("\n"))
      : await w.withIndex(renderWorkItem(item, { includeSpec: false }), item.problem),
    tools: READ_TOOLS,
    model_class: model,
    output_schema: TRIAGE_SCHEMA,
  });
  const spec = parseTriage(result.output);
  if (!spec.ok) throw new RunFailure("invalid_output", spec.error, false, { output_tail: tail(result.transcript) });
  return { spec: spec.value };
}

export default defineRunKind({
  name: "triage",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => triage(w, c.run, c.item, c.handle!, c.signal, c.model),
});
