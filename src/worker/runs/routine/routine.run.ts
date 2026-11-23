import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, defineRunKind } from "../../run-kind.js";

/** What a routine run reads (`input.routine`): the owner's instruction and the one URL Browse may GET, fixed at enqueue. */
export type RoutineInput = NonNullable<NonNullable<RunCall["run"]["input"]>["routine"]>;

/**
 * The routine's output schema: `pass` when nothing needs the owner's attention, `bug` with one finding per suggestion.
 * It lives with the run so the worker adds no import of core/ (the dependency ratchets).
 */
export const ROUTINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["pass", "bug"], description: "pass: nothing needs attention; bug: at least one finding does." },
    findings: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", description: "What, where (file and line, or the page) and why." } } },
    },
    summary: { type: "string" },
  },
};

/**
 * A routine answer's verdict and findings (each finding a code finding, so golden scores it as a review's), or why
 * it has none: a verdict other than pass or bug, or a finding with no text.
 */
export function parseRoutine(v: unknown): { ok: true; value: { verdict: "pass" | "bug"; findings: { kind: "code"; text: string }[] } } | { ok: false; error: string } {
  const o = typeof v === "object" && v !== null ? (v as { verdict?: unknown; findings?: unknown }) : {};
  if (o.verdict !== "pass" && o.verdict !== "bug") return { ok: false, error: "verdict" };
  const findings = Array.isArray(o.findings) ? (o.findings as { text?: unknown }[]) : [];
  if (findings.some((f) => typeof f?.text !== "string")) return { ok: false, error: "findings" };
  return { ok: true, value: { verdict: o.verdict, findings: findings.map((f) => ({ kind: "code" as const, text: f.text as string })) } };
}

/** The routine's prompt: the owner's instruction and the page it may fetch. */
export function renderRoutinePrompt(r: RoutineInput): string {
  return ["## Instruction", "", r.instruction, "", "## Page", "", r.url ?? "None: Browse refuses every call."].join("\n");
}

/**
 * The routine run, in a read-only folder at the base: one journaled agent step with the role's tools (Read, Glob,
 * Grep, Browse). The answer is stored as it came (`routine`); it pushes, posts and merges nothing. A missing
 * prompts/routine.md fails the run with `prompt_missing` before any agent runs.
 */
async function routine(w: Worker, c: RunCall): Promise<Record<string, unknown>> {
  const input = c.run.input?.routine;
  if (!input) return { routine: null };
  await w.roleSpec("routine");
  return c.step("run-agent", async () => {
    const result = await w.agent(c.run, c.item, c.handle!, c.signal, { prompt: renderRoutinePrompt(input), model_class: c.model, output_schema: ROUTINE_SCHEMA });
    return { routine: result.output ?? null };
  });
}

export default defineRunKind({
  name: "routine",
  folder: true,
  timeouts: DEFAULT_TIMEOUTS,
  execute: (w, c) => routine(w, c),
});
