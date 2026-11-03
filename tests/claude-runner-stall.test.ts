import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { Read } from "../src/core/tools/index.js";
import { ClaudeCodeRunner, buildClaudeArgs } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, Sandbox } from "../src/interfaces/sandbox.js";

// Design §5 Restarts, stall detection: the runner reads the CLI's streamed events (stream-json) and ends a run
// that printed nothing for stall_ms while no tool call was open, with status `stalled`, long before
// run_timeout_ms.

const STALL_MS = 120;
const TIMEOUT_MS = 30_000;

/** Waits `ms`, or less when `signal` aborts first. */
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Waits until `signal` aborts, or `max` ms (the fake's own run timeout). */
const untilAborted = (signal: AbortSignal | undefined, max = TIMEOUT_MS) => wait(max, signal);

type Script = (opts: ExecOptions, out: (line: unknown) => void) => Promise<{ exit_code: number }>;

function runnerWith(script: Script) {
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (_h, _cmd, opts): Promise<ExecResult> => {
      let stdout = "";
      const out = (line: unknown) => {
        const chunk = `${JSON.stringify(line)}\n`;
        stdout += chunk;
        opts.onStdout?.(chunk);
      };
      const { exit_code } = await script(opts, out);
      return { exit_code, signal: null, stdout, stderr: "", timed_out: false };
    },
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-runner-stall-test`;
  return new ClaudeCodeRunner({
    sandbox,
    secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
    claudeConfigDir: `${homes}/cfg`,
    homesDir: homes,
    models: { cheap: "haiku", standard: "sonnet", strong: "opus" },
  });
}

const spec = (): AgentRunSpec => ({
  run_id: "run_1" as RunId,
  work_item_id: "wi_1" as WorkItemId,
  role: "triage",
  sandbox: { id: "s", workdir: "/w" },
  system_prompt: "s",
  prompt: "p",
  tools: [Read],
  tool_grants: [],
  lease_token: 1,
  env_allowlist: {},
  deny_paths: [],
  writable_paths: [],
  model_class: "cheap",
  timeout_ms: TIMEOUT_MS,
  stall_ms: STALL_MS,
  signal: new AbortController().signal,
});

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 0.01,
  usage: { input_tokens: 3, output_tokens: 4 },
};
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const toolUse = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

describe("ClaudeCodeRunner: stall detection", () => {
  it("asks the CLI for streamed events", () => {
    const args = buildClaudeArgs(spec(), "haiku");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
  });

  it("a CLI that prints nothing ends `stalled` at about stall_ms, not at run_timeout_ms", async () => {
    const started = Date.now();
    const r = await runnerWith(async (opts) => {
      await untilAborted(opts.signal);
      return { exit_code: 143 };
    }).run(spec());
    const took = Date.now() - started;
    expect(r.status).toBe("stalled");
    expect(r.error).toContain(`${STALL_MS}`);
    expect(took).toBeGreaterThanOrEqual(STALL_MS - 10);
    expect(took).toBeLessThan(TIMEOUT_MS / 3);
  });

  it("silence after some events is a stall too", async () => {
    const r = await runnerWith(async (opts, out) => {
      out({ type: "system", subtype: "init" });
      out(text("thinking"));
      await untilAborted(opts.signal);
      return { exit_code: 143 };
    }).run(spec());
    expect(r.status).toBe("stalled");
  });

  it("events at intervals shorter than stall_ms, then a result, end `completed`", async () => {
    const r = await runnerWith(async (opts, out) => {
      out({ type: "system", subtype: "init" });
      for (let i = 0; i < 6; i++) {
        await wait(STALL_MS / 3, opts.signal);
        out(text(`step ${i}`));
      }
      out(RESULT);
      return { exit_code: 0 };
    }).run(spec());
    expect(r.status).toBe("completed");
    expect(r.output).toBe("done");
    expect(r.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, cost_usd: 0.01 });
  });

  it("an open tool call past stall_ms is not a stall; the clock starts again once it returns", async () => {
    const r = await runnerWith(async (opts, out) => {
      out(toolUse("toolu_1"));
      await wait(STALL_MS * 3, opts.signal);
      if (opts.signal?.aborted) return { exit_code: 143 };
      out(toolResult("toolu_1"));
      out(RESULT);
      return { exit_code: 0 };
    }).run(spec());
    expect(r.status).toBe("completed");

    const stalled = await runnerWith(async (opts, out) => {
      out(toolUse("toolu_1"));
      await wait(STALL_MS * 2, opts.signal);
      out(toolResult("toolu_1"));
      await untilAborted(opts.signal);
      return { exit_code: 143 };
    }).run(spec());
    expect(stalled.status).toBe("stalled");
  });

  it("an abort from the worker stays `aborted`, not `stalled`", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), STALL_MS / 3);
    const r = await runnerWith(async (opts) => {
      await untilAborted(opts.signal);
      return { exit_code: 143 };
    }).run({ ...spec(), signal: ctl.signal });
    expect(r.status).toBe("aborted");
  });

  it("reads the outcome from the last result event: a 429 is still rate_limited", async () => {
    const r = await runnerWith(async (_opts, out) => {
      out({ type: "system", subtype: "init" });
      out({ type: "result", is_error: true, result: "limit reached|1762000200", api_error_status: 429 });
      return { exit_code: 1 };
    }).run(spec());
    expect(r).toMatchObject({ status: "rate_limited", reset_at: "2025-11-01T12:30:00.000Z" });
  });
});
