import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { Run, WorkItem } from "../src/core/types.js";
import type { Worker } from "../src/worker/runner.js";
import type { RunCall } from "../src/worker/run-kind.js";
import { RunFailure } from "../src/worker/support.js";
import triage from "../src/worker/runs/triage/triage.run.js";
import { triageSpec } from "./helpers/fakes/config.js";

// Issue #488: a tool-call markup refusal gets one re-prompt in the same step; nothing else does.
const STRAY = `The runner fails.</problem>\n<${"parameter"} name="decisions">[]`;
const clean = { ...triageSpec, decisions: [] };
const stray = { ...clean, problem: STRAY };

/**
 * A fake worker whose agent returns the scripted outputs in order and records each prompt and step name; with `tests`,
 * its run folder's git lists them as the base's tests/ files (else git cannot list them and nothing is checked).
 */
function fakeWorker(outputs: unknown[], tests?: string[]) {
  const calls: { prompt: string; step: string | undefined }[] = [];
  const w = {
    d: { store: { listStateChanges: async () => [] } },
    ...(tests ? { gitRaw: async () => ({ exit_code: 0, stdout: tests.map((f) => `${f}\0`).join(""), stderr: "" }) } : {}),
    withIndex: async (prompt: string) => prompt,
    agent: async (_r: Run, _i: WorkItem, _h: unknown, _s: AbortSignal, role: { prompt: string }, step?: string) => {
      calls.push({ prompt: role.prompt, step });
      return { output: outputs[calls.length - 1], transcript: `transcript ${calls.length}` } as AgentRunResult;
    },
  } as unknown as Worker;
  return { w, calls };
}

async function run(outputs: unknown[], tests?: string[]) {
  const { w, calls } = fakeWorker(outputs, tests);
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

// Done-check test files exist on the base or are marked new (design 04-triage, 2026-11-24): a missing, unmarked one, or
// a marked one allowed_paths does not cover, is sent back once in the same step; a second such answer fails the run.
describe("triage re-prompt on a done-check test file the base lacks", () => {
  const BASE = ["tests/scope-gate.test.ts", "tests/data-table-docs.test.ts"];
  const LINE = clean.done_criteria[0]!;
  const naming = (test_file: string, o: Record<string, unknown> = {}) => ({ ...clean, done_checks: [{ line: LINE, test_file, ...o }] });

  it("sends a missing, unmarked file back once with its name, even with a close existing file, and keeps the fixed answer", async () => {
    const fixed = naming("tests/table-docs.test.ts", { new: true });
    const { result, calls, steps } = await run([naming("tests/table-docs.test.ts"), { ...fixed, allowed_paths: [...clean.allowed_paths, "tests/table-docs.test.ts"] }], BASE);
    const out = (await result) as { spec: { done_checks: unknown[]; decision_items?: unknown[] } };
    expect(calls).toHaveLength(2);
    expect(steps).toEqual(["run-agent"]);
    expect(calls[1]!.step).toBe("check-files-retry");
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
    expect(calls[1]!.prompt).toContain("not marked new: true: tests/table-docs.test.ts");
    expect(out.spec.done_checks).toEqual([{ line: LINE, test_file: "tests/table-docs.test.ts", new: true }]);
    expect(out.spec.decision_items ?? []).toEqual([]);
  });

  it("fails as invalid_output naming the files when the second answer still names one, with no third call", async () => {
    const { result, calls } = await run([naming("tests/zzz.test.ts"), naming("tests/zzz.test.ts"), clean], BASE);
    const err = await result.then(() => null, (e: unknown) => e);
    expect((err as RunFailure).code).toBe("invalid_output");
    expect((err as RunFailure).message).toContain("tests/zzz.test.ts");
    expect(calls).toHaveLength(2);
  });

  it("accepts a marked file allowed_paths covers with no re-ask; sends an uncovered one back with its name", async () => {
    const covered = { ...naming("tests/new/a.test.ts", { new: true }), allowed_paths: [...clean.allowed_paths, "tests/new/"] };
    const ok = await run([covered], BASE);
    expect(((await ok.result) as { spec: { done_checks: unknown[] } }).spec.done_checks).toEqual([{ line: LINE, test_file: "tests/new/a.test.ts", new: true }]);
    expect(ok.calls).toHaveLength(1);

    const uncovered = await run([naming("tests/new/a.test.ts", { new: true }), covered], BASE);
    await uncovered.result;
    expect(uncovered.calls).toHaveLength(2);
    expect(uncovered.calls[1]!.prompt).toContain("allowed_paths does not cover them: tests/new/a.test.ts");
  });

  it("checks nothing when the base lists no tests/ file (a fixture run folder, a repo with no tests yet)", async () => {
    const { result, calls } = await run([naming("tests/first.test.ts")], []);
    expect(((await result) as { spec: { done_checks: unknown[] } }).spec.done_checks).toEqual([{ line: LINE, test_file: "tests/first.test.ts" }]);
    expect(calls).toHaveLength(1);
  });

  it("makes one call and keeps the spec as it is when every done-check file exists", async () => {
    const { result, calls } = await run([clean], BASE);
    const out = (await result) as { spec: Record<string, unknown> };
    expect(calls).toHaveLength(1);
    expect(out.spec.done_checks).toEqual(clean.done_checks);
    expect(out.spec.done_criteria).toEqual(clean.done_criteria);
  });
});
