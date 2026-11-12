import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { Run, WorkItem } from "../src/core/types.js";
import type { Worker } from "../src/worker/runner.js";
import type { RunCall } from "../src/worker/run-kind.js";
import { RunFailure } from "../src/worker/support.js";
import triage from "../src/worker/runs/triage/triage.run.js";
import { triageSpec } from "./helpers/fakes.js";

// Issue #488: a tool-call markup refusal gets one re-prompt in the same step; nothing else does.
const STRAY = `The runner fails.</problem>\n<${"parameter"} name="decisions">[]`;
const clean = { ...triageSpec, decisions: [] };
const stray = { ...clean, problem: STRAY };

/** A fake worker whose agent returns the scripted outputs in order and records each prompt and step name. */
function fakeWorker(outputs: unknown[]) {
  const calls: { prompt: string; step: string | undefined }[] = [];
  const w = {
    d: { store: { listStateChanges: async () => [] } },
    withIndex: async (prompt: string) => prompt,
    agent: async (_r: Run, _i: WorkItem, _h: unknown, _s: AbortSignal, role: { prompt: string }, step?: string) => {
      calls.push({ prompt: role.prompt, step });
      return { output: outputs[calls.length - 1], transcript: `transcript ${calls.length}` } as AgentRunResult;
    },
  } as unknown as Worker;
  return { w, calls };
}

async function run(outputs: unknown[]) {
  const { w, calls } = fakeWorker(outputs);
  const item = { id: "wi_1", source: { link: "https://example.test/1" }, problem: "Fix the runner.", revision_count: 0, allowed_paths: [] } as unknown as WorkItem;
  const steps: string[] = [];
  const call = {
    run: { id: "run_1" } as Run,
    item,
    signal: new AbortController().signal,
    model: "cheap",
    handle: {},
    step: async (id: string, fn: () => Promise<unknown>) => { steps.push(id); return fn(); },
  } as unknown as RunCall;
  const result = triage.execute(w, call);
  return { result, calls, steps };
}

describe("triage re-prompt on tool-call markup (issue #488)", () => {
  it("calls the agent once more with the exact error, and succeeds on a clean answer", async () => {
    const { result, calls, steps } = await run([stray, clean]);
    const out = (await result) as { spec: { problem: string } };
    expect(out.spec.problem).toBe(clean.problem);
    expect(calls).toHaveLength(2);
    expect(steps).toEqual(["run-agent"]);
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
    expect(calls[1]!.prompt).toContain("problem: tool-call markup outside code");
    expect(calls[1]!.prompt).toContain("Answer with the JSON only.");
    expect(calls[1]!.step).toBe("markup-retry");
  });

  it("fails as invalid_output with the second error after a second refusal, with no third call", async () => {
    const { result, calls } = await run([stray, { ...clean, tier_reason: "</function_calls>" }, clean]);
    const err = await result.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunFailure);
    expect((err as RunFailure).code).toBe("invalid_output");
    expect((err as RunFailure).message).toContain("tier_reason: tool-call markup outside code");
    expect(calls).toHaveLength(2);
  });

  it("makes exactly one call when the first answer parses, with the same output", async () => {
    const { result, calls } = await run([clean]);
    const out = (await result) as { spec: Record<string, unknown> };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.step).toBeUndefined();
    expect(out.spec.problem).toBe(clean.problem);
    expect(out.spec.allowed_paths).toEqual(clean.allowed_paths);
  });

  it("does not re-prompt another invalid output", async () => {
    const { result, calls } = await run([{ not: "a spec" }, clean]);
    const err = await result.then(() => null, (e: unknown) => e);
    expect((err as RunFailure).code).toBe("invalid_output");
    expect((err as RunFailure).message).not.toContain("tool-call markup");
    expect(calls).toHaveLength(1);
  });
});
