import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { Bash, Edit, Read } from "../src/core/tools/index.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecResult, Sandbox } from "../src/interfaces/sandbox.js";

// Design §5 Restarts, stopped runs keep their work: a run the runner killed (timeout, stall) never prints the CLI's
// result event, so its usage comes from the per-message usage in the stream, counted once per message id, with a
// null cost. The runner also reports whether the agent called a write-capable tool (did_work).

function runnerWith(events: unknown[], timed_out: boolean) {
  const stdout = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (): Promise<ExecResult> => ({ exit_code: timed_out ? 143 : 0, signal: null, stdout, stderr: "", timed_out }),
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-runner-usage-test`;
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
  role: "implement",
  sandbox: { id: "s", workdir: "/w" },
  system_prompt: "s",
  prompt: "p",
  tools: [Read, Edit, Bash],
  tool_grants: [],
  lease_token: 1,
  env_allowlist: {},
  deny_paths: [],
  writable_paths: [],
  model_class: "standard",
  timeout_ms: 30_000,
  signal: new AbortController().signal,
});

const usage = (input: number, output: number, cache_read = 0, cache_write = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cache_read, cache_creation_input_tokens: cache_write,
});
/** One assistant event: the CLI prints one per content block, each with its message's id and usage. */
const assistant = (id: string, u: ReturnType<typeof usage>, block: unknown, model = "claude-sonnet") => ({
  type: "assistant", message: { id, model, usage: u, content: [block] },
});
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string) => ({ type: "tool_use", id: `t_${name}`, name, input: {} });

describe("ClaudeCodeRunner: usage of a killed run", () => {
  it("a timed-out run records the usage its stream reported, once per message id, with a null cost", async () => {
    const r = await runnerWith([
      { type: "system", subtype: "init" },
      assistant("msg_1", usage(100, 20, 50, 10), text("looking")),
      // The same message again (a second content block): counted once.
      assistant("msg_1", usage(100, 20, 50, 10), tool("Read")),
      assistant("msg_2", usage(7, 30, 150, 0), text("next")),
    ], true).run(spec());
    expect(r.status).toBe("timed_out");
    expect(r.usage).toEqual({
      input_tokens: 107, output_tokens: 50, cache_read_tokens: 200, cache_write_tokens: 10, cost_usd: null, model: "claude-sonnet",
    });
    expect(r.did_work).toBe(false);
  });

  it("a write-capable tool call marks the run as having work", async () => {
    const edit = await runnerWith([assistant("m1", usage(1, 1), tool("Edit"))], true).run(spec());
    expect(edit.did_work).toBe(true);
    const bash = await runnerWith([assistant("m1", usage(1, 1), tool("Bash"))], true).run(spec());
    expect(bash.did_work).toBe(true);
  });

  it("a run with a result event keeps the result's usage and cost", async () => {
    const r = await runnerWith([
      assistant("m1", usage(1, 1), tool("Edit")),
      { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.5, usage: { input_tokens: 9, output_tokens: 8 } },
    ], false).run(spec());
    expect(r.status).toBe("completed");
    expect(r.usage).toMatchObject({ input_tokens: 9, output_tokens: 8, cost_usd: 0.5 });
    expect(r.did_work).toBe(true);
  });

  it("a stream with no assistant event records zeros", async () => {
    const r = await runnerWith([{ type: "system", subtype: "init" }], true).run(spec());
    expect(r.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: null });
    expect(r.did_work).toBe(false);
  });
});
