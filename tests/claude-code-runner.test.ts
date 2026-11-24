import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { Read } from "../src/core/tools/index.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { contextFeed } from "../src/impl/runner/context-feed.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecResult, Sandbox } from "../src/interfaces/sandbox.js";

// Design §5 Restarts, the context ceiling: the runner reads each model call's context (input + cache read + cache
// write tokens) from the CLI's stream and reports it once per call through the spec's `on_context`.

const usage = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 7 });
const assistant = (id: string, u: object, text = "t") => ({ type: "assistant", message: { id, usage: u, content: [{ type: "text", text }] } });
const RESULT = { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } };

/** A runner whose CLI prints `events` as stream-json lines, each chunk cut in two mid-line. */
function runnerPrinting(events: unknown[]) {
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (_h, _cmd, opts): Promise<ExecResult> => {
      const stdout = events.map((e) => `${JSON.stringify(e)}\n`).join("");
      for (const line of stdout.split(/(?<=\n)/)) {
        const cut = Math.floor(line.length / 2);
        opts.onStdout?.(line.slice(0, cut));
        opts.onStdout?.(line.slice(cut));
      }
      return { exit_code: 0, signal: null, stdout, stderr: "", timed_out: false };
    },
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-runner-context-test`;
  return new ClaudeCodeRunner({
    sandbox,
    secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
    claudeConfigDir: `${homes}/cfg`,
    homesDir: homes,
    models: { cheap: "haiku", standard: "sonnet", strong: "opus" },
  });
}

const spec = (on_context?: (tokens: number) => void): AgentRunSpec => ({
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
  timeout_ms: 30_000,
  signal: new AbortController().signal,
  ...(on_context ? { on_context } : {}),
});

describe("ClaudeCodeRunner: each model call's context", () => {
  it("reports input + cache read + cache write tokens once per model call, from the stream", async () => {
    const seen: number[] = [];
    const r = await runnerPrinting([
      { type: "system", subtype: "init" },
      assistant("msg_1", usage(10, 1_000, 200), "a"),
      assistant("msg_1", usage(10, 1_000, 200), "b"), // the same call's second content block
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "assistant" }] } },
      assistant("msg_2", usage(5, 140_000, 9_995)),
      RESULT,
    ]).run(spec((t) => seen.push(t)));
    expect(r.status).toBe("completed");
    expect(seen).toEqual([1_210, 150_000]);
  });

  it("a spec without on_context reads nothing and runs as before", async () => {
    const r = await runnerPrinting([assistant("msg_1", usage(1, 2, 3)), RESULT]).run(spec());
    expect(r.status).toBe("completed");
    expect(contextFeed(undefined)).toBeUndefined();
  });

  it("the feed skips lines that are not assistant events with usage", () => {
    const seen: number[] = [];
    const feed = contextFeed((t) => seen.push(t))!;
    feed('{"type":"assistant", not json\n');
    feed(`${JSON.stringify({ type: "assistant", message: { id: "m", content: [] } })}\n`);
    feed(`${JSON.stringify(assistant("m2", { input_tokens: -1, cache_read_input_tokens: "x", cache_creation_input_tokens: 4 }))}\n`);
    expect(seen).toEqual([4]);
  });
});
