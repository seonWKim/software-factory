import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { ClaudeCodeRunner, parseRateLimitReset } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecResult, Sandbox } from "../src/interfaces/sandbox.js";

// A `claude -p --output-format json` result for a usage limit. The repo has no real sample yet (open
// question on the PR): this follows the CLI's result shape with `api_error_status: 429`.
const NOW = new Date("2026-11-01T09:00:00.000Z");
const RESET_EPOCH_S = Date.parse("2026-11-01T12:10:00.000Z") / 1000;
const CAPTURED_429 = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  duration_ms: 412,
  duration_api_ms: 0,
  num_turns: 1,
  result: `Claude AI usage limit reached|${RESET_EPOCH_S}`,
  session_id: "00000000-0000-0000-0000-000000000000",
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  api_error_status: 429,
});

function runnerWith(stdout: string, exit_code = 1) {
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (): Promise<ExecResult> => ({ exit_code, signal: null, stdout, stderr: "", timed_out: false }),
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-runner-test`;
  return new ClaudeCodeRunner({
    sandbox,
    secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
    claudeConfigDir: `${homes}/cfg`,
    homesDir: homes,
    models: { cheap: "haiku", strong: "opus" },
    now: () => NOW,
  });
}

const spec = (): AgentRunSpec => ({
  run_id: "run_1" as RunId,
  work_item_id: "wi_1" as WorkItemId,
  role: "triage",
  sandbox: { id: "s", workdir: "/w" },
  system_prompt: "s",
  prompt: "p",
  harness_tools: ["Read"],
  tool_grants: [],
  lease_token: 1,
  env_allowlist: {},
  deny_paths: [],
  writable_paths: [],
  model_class: "cheap",
  timeout_ms: 1000,
  signal: new AbortController().signal,
});

describe("ClaudeCodeRunner: usage and rate limits", () => {
  it("turns a captured 429 result into a rate_limited outcome with the parsed reset time", async () => {
    const r = await runnerWith(CAPTURED_429).run(spec());
    expect(r).toMatchObject({ status: "rate_limited", reset_at: "2026-11-01T12:10:00.000Z", output: null });
    expect(r.transcript).toBe(CAPTURED_429);
  });

  it("a 429 whose text gives no reset time is rate_limited with no reset_at", async () => {
    const r = await runnerWith(JSON.stringify({ type: "result", is_error: true, result: "rate limited", api_error_status: 429 })).run(spec());
    expect(r.status).toBe("rate_limited");
    expect(r.reset_at).toBeUndefined();
  });

  it("any other error stays failed", async () => {
    const r = await runnerWith(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 500 })).run(spec());
    expect(r).toMatchObject({ status: "failed", error: "error_during_execution" });
  });
});

describe("parseRateLimitReset", () => {
  it("reads an epoch suffix in seconds or milliseconds", () => {
    expect(parseRateLimitReset(`limit reached|${RESET_EPOCH_S}`, NOW)).toBe("2026-11-01T12:10:00.000Z");
    expect(parseRateLimitReset(`limit reached|${RESET_EPOCH_S * 1000}`, NOW)).toBe("2026-11-01T12:10:00.000Z");
  });

  it("reads `resets 12:10pm (Zone)` as the next such wall-clock time in that zone", () => {
    // 09:00Z is 18:00 in Seoul; 12:10pm Seoul next is 03:10Z the next day.
    expect(parseRateLimitReset("5-hour limit reached ∙ resets 12:10pm (Asia/Seoul)", NOW)).toBe("2026-11-02T03:10:00.000Z");
    expect(parseRateLimitReset("limit reached · resets 3pm (UTC)", NOW)).toBe("2026-11-01T15:00:00.000Z");
    expect(parseRateLimitReset("resets 12am (UTC)", NOW)).toBe("2026-11-02T00:00:00.000Z");
  });

  it("returns null for text it cannot read", () => {
    expect(parseRateLimitReset("rate limited", NOW)).toBeNull();
    expect(parseRateLimitReset("resets 12:10pm (Not/AZone)", NOW)).toBeNull();
    expect(parseRateLimitReset("resets 13pm (UTC)", NOW)).toBeNull();
  });
});
