import { TRIAGE_SCHEMA, checkTestFiles, parseTriage } from "../../../core/outputs.js";
import type { Run, WorkItem } from "../../../core/types.js";
import type { SandboxHandle } from "../../../interfaces/sandbox.js";
import { ownerAnswersFor } from "../../../shared/command-notes.js";
import { RunFailure, addedContext, renderAttachments, renderOwnerAnswers, renderRevision, renderWorkItem, tail } from "../../support.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

/** The `parseTriage` refusal (issue #454) that earns one re-prompt (issue #488); any other refusal fails at once. */
const MARKUP_REFUSAL = ": tool-call markup outside code";

/** The base's files under tests/, from the run folder's index; null when git cannot list them (then nothing is checked). */
async function testFiles(w: Worker, handle: SandboxHandle): Promise<string[] | null> {
  try {
    const r = await w.gitRaw(handle, ["ls-files", "-z", "--", "tests"]);
    return r.exit_code === 0 ? r.stdout.split("\0").filter(Boolean) : null;
  } catch {
    return null; // a sandbox that cannot run git (a narrow test fake)
  }
}

async function triage(w: Worker, run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal, model: RunCall["model"], step: RunCall["step"]) {
  // One journaled step: a takeover after it returns the stored spec.
  return step("run-agent", async () => {
    // The owner's stored answers bind every re-write of the spec, a phase's from its parent's split (design 04-agents.md).
    // The item's own changes are read once: they carry both its answers and its added context.
    const own = await w.d.store.listStateChanges(item.id);
    const answers = renderOwnerAnswers(await ownerAnswersFor(item, (id) => (id === item.id ? Promise.resolve(own) : w.d.store.listStateChanges(id))));
    // Context added on a New or in-triage item and its attachments (design 02-attachments): untrusted, after the filed text; images as image input.
    // A store without attachments (a narrow test fake) reads as none.
    const [contexts, attachments] = [addedContext(own), (await w.d.store.listAttachments?.(item.id)) ?? []];
    const added = renderAttachments(contexts, attachments);
    const images = attachments.flatMap((a) => (a.kind === "image" && a.media_type && a.data ? [{ media_type: a.media_type, data: a.data }] : []));
    const base = item.revision_count > 0
      ? await w.withIndex(renderRevision(item, answers), [item.issue_text ?? item.problem, item.spec_feedback ?? "", ...contexts].join("\n"))
      : await w.withIndex(renderWorkItem(item, { includeSpec: false, answers }), [item.problem, ...contexts].join("\n"));
    const prompt = added ? `${base}\n\n${added}` : base;
    const ask = (text: string, agentStep?: string) =>
      w.agent(run, item, handle, signal, { prompt: text, model_class: model, output_schema: TRIAGE_SCHEMA, ...(images.length > 0 ? { images } : {}) }, agentStep);
    // The run folder is a checkout of the base (no clone of its own): its tests/ files are what the spec's test file names are checked against (design 04-pre-push-gates).
    const tests = await testFiles(w, handle);
    const parse = (output: unknown) => parseTriage(tests ? checkTestFiles(output, tests) : output);
    let result = await ask(prompt);
    let spec = parse(result.output);
    if (!spec.ok && spec.error.endsWith(MARKUP_REFUSAL)) {
      // One more call in the same step, naming the error; a second refusal fails the run with that error.
      result = await ask(
        `${prompt}\n\n## Your previous answer was refused\n\n${spec.error}\n\nNever write tool-call tags inside a field value. Answer with the JSON only.`,
        "markup-retry",
      );
      spec = parse(result.output);
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
