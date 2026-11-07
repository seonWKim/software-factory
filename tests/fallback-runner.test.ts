import { describe, expect, it } from "vitest";
import { FallbackRunner, canFallOver } from "../src/core/fallback-runner.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../src/interfaces/agent-runner.js";
import type { SandboxHandle } from "../src/interfaces/sandbox.js";

// The did-work flag (design §5 Restarts, stopped runs keep their work): a member that called a write-capable tool
// before it stalled has changed the workdir, so the chain does not hand that workdir to the next member. A rate
// limit still falls over as before.

const res = (status: AgentRunResult["status"], extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
  status, output: null, transcript: "", usage: { input_tokens: 1, output_tokens: 0, cost_usd: null }, ...extra,
});

class Once implements AgentRunner {
  calls = 0;
  constructor(private readonly result: AgentRunResult) {}
  async run(): Promise<AgentRunResult> {
    this.calls++;
    return this.result;
  }
}

const spec = (): AgentRunSpec => ({
  run_id: "run_1" as RunId, work_item_id: "wi_1" as WorkItemId, role: "implement", sandbox: {} as SandboxHandle,
  system_prompt: "", prompt: "", tools: [], tool_grants: [], lease_token: 1, env_allowlist: {}, deny_paths: [],
  writable_paths: [], model_class: "standard", timeout_ms: 1000, signal: new AbortController().signal,
});

async function served(first: AgentRunResult) {
  const a = new Once(first);
  const b = new Once(res("completed"));
  const r = await new FallbackRunner([{ name: "a", impl: a }, { name: "b", impl: b }]).run(spec());
  return { r, next: b.calls };
}

describe("FallbackRunner: the did-work flag", () => {
  it("a stall after a write-capable tool call stands, even with no output tokens", async () => {
    const { r, next } = await served(res("stalled", { did_work: true }));
    expect(next).toBe(0);
    expect(r).toMatchObject({ status: "stalled", served_by: "a", did_work: true });
    expect(r.fallbacks).toBeUndefined();
  });

  it("a stall the runner reports as no work falls over, also with output tokens from the stream", async () => {
    const { r, next } = await served(res("stalled", { did_work: false, usage: { input_tokens: 5, output_tokens: 30, cost_usd: null } }));
    expect(next).toBe(1);
    expect(r).toMatchObject({ status: "completed", served_by: "b" });
  });

  it("a runner that does not report the flag keeps the output-token rule", () => {
    expect(canFallOver(res("stalled"))).toBe(true);
    expect(canFallOver(res("stalled", { usage: { input_tokens: 1, output_tokens: 3, cost_usd: null } }))).toBe(false);
  });

  it("a rate limit still falls over after work", async () => {
    const { r, next } = await served(res("rate_limited", { did_work: true }));
    expect(next).toBe(1);
    expect(r.fallbacks?.[0]).toMatchObject({ from: "a", to: "b" });
  });
});
