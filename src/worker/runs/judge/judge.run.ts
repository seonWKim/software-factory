import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

/** What a judge run reads (`input.judge`, design 04-split-specs): fixed by the controller when it queued the run. */
export type JudgeInput = NonNullable<NonNullable<RunCall["run"]["input"]>["judge"]>;

const strings = { type: "array", items: { type: "string" } };
/**
 * The judge's output schema (design 04-split-specs): a verdict of next, fix, done or ask and a reason; with fix, the
 * phase to add, each field required. The controller checks the stored answer with `parseJudge` (src/core/outputs.ts).
 * It lives with the run so the worker adds no import of core/ (the dependency ratchets).
 */
export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: { type: "string", enum: ["next", "fix", "done", "ask"], description: "next: the next phase may start; fix: a phase must be added; done: every goal line holds; ask: only the owner can decide." },
    reason: { type: "string", description: "Why, in one or two plain sentences naming the goal lines that decide it." },
    fix: {
      type: "object",
      additionalProperties: false,
      required: ["title", "problem", "done_criteria", "allowed_paths"],
      description: "Only with verdict fix: the phase to add.",
      properties: { title: { type: "string" }, problem: { type: "string" }, done_criteria: { ...strings, minItems: 1 }, allowed_paths: { ...strings, minItems: 1 } },
    },
  },
};

/** The judge's prompt: the goal lines, the recorded phases' titles, the merged phase's spec and its merge sha. */
export function renderJudgePrompt(j: JudgeInput): string {
  return [
    "## Goal lines", "", ...j.goal_done_when.map((g) => `- ${g}`), "",
    "## Recorded phases", "", ...j.phases.map((t, i) => `${i + 1}. ${t}${i + 1 === j.phase ? " (this phase, just closed)" : ""}${i + 1 === j.phases.length ? " (last)" : ""}`), "",
    `## This phase: phase ${j.phase} of ${j.phases.length}`, "", `Title: ${j.title}`, "", `Merge sha: ${j.merge_sha}`, "",
    "### Problem", "", j.problem, "",
    "### Done criteria", "", ...j.done_criteria.map((c) => `- ${c}`),
  ].join("\n");
}

/**
 * The judge run (design 04-split-specs), on its goal split's parent, in a folder at the base the phase merged into:
 * one journaled agent step on the class the runner pins (strong), with the role's read-only tools. The answer is
 * stored as it came (`verdict`); the controller checks it, and retries one that fails the check as `invalid_output`.
 * A missing prompts/judge.md fails the run with `prompt_missing` before any agent runs.
 */
async function judge(w: Worker, c: RunCall): Promise<Record<string, unknown>> {
  const input = c.run.input?.judge;
  if (!input) return { verdict: null };
  await w.roleSpec("judge");
  return c.step("run-agent", async () => {
    const result = await w.agent(c.run, c.item, c.handle!, c.signal, { prompt: renderJudgePrompt(input), model_class: c.model, output_schema: JUDGE_SCHEMA });
    return { verdict: result.output ?? null };
  });
}

export default defineRunKind({
  name: "judge",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => judge(w, c),
});
