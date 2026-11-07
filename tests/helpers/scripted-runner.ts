import { Grep, Read, type ToolResult, type ToolSpec, guardPolicy } from "../../src/core/tools/index.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../../src/interfaces/agent-runner.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { Sandbox } from "../../src/interfaces/sandbox.js";
import type { ToolBroker } from "../../src/interfaces/tool-broker.js";
import { grantedTools } from "../../src/impl/runner/tool-gateway.js";

// A test-only AgentRunner with no harness of its own (#90, part 3 of 3 for #58). A scripted fake LLM drives
// it; every tool call goes through `ToolSpec.run` from src/core/tools, so the file guards (deny_paths, `.env`,
// workdir bounds) come from the shared tools, not from this runner. It never reads a file itself.
// Never registered in REGISTRY: tests select it with `withPlugin(REGISTRY, "runner", ...)`.
// Given a broker and a scanner, it also exposes the run's granted broker tools: a script step naming one goes
// through the same worker-side gateway as the Claude Code runner's bridge (grant check, broker call with the
// run's context, egress scan of the result).

/** One step of the fake LLM's script: a tool call, or the final answer that ends the run. */
export type ScriptStep = { tool: string; input: unknown } | { final: unknown };

/** What the fake LLM saw back from one tool call: the tool result, as a real model would get it. */
export interface Observation {
  tool: string;
  input: unknown;
  result: ToolResult;
}

/**
 * A fake LLM that answers from a fixed list of steps, whatever it is told. It records every tool result it
 * is given, so a test can check what came back to the "model".
 */
export class ScriptedLLM {
  readonly observations: Observation[] = [];
  private i = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {}

  /** The next step; `last` is the result of the previous tool call, if any. */
  next(last: Observation | null): ScriptStep {
    if (last) this.observations.push(last);
    const step = this.steps[this.i++];
    if (!step) throw new Error("script ran out of steps before a final answer");
    return step;
  }
}

/** The shared tools this runner exposes. Only these two: the scripted tasks are read-only. */
const RUNNER_TOOLS: readonly ToolSpec[] = [Read, Grep];

export class ScriptedRunner implements AgentRunner {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly llm: ScriptedLLM,
    private readonly broker?: { broker: ToolBroker; scanner: EgressScanner },
  ) {}

  get exposes_tools(): boolean {
    return this.broker !== undefined;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    // The one policy every shared tool enforces, built from the spec only: nothing here checks a path.
    const policy = guardPolicy({
      workdir: spec.sandbox.workdir,
      deny_paths: spec.deny_paths,
      writable_paths: spec.writable_paths,
      env_allowlist: spec.env_allowlist,
    });
    const ctx = { sandbox: this.sandbox, handle: spec.sandbox, policy, signal: spec.signal };
    if (spec.tool_grants.length > 0 && !this.broker) {
      return { status: "failed", output: null, transcript: "", usage: { input_tokens: 0, output_tokens: 0, cost_usd: null }, error: `tools_not_exposed: ${spec.tool_grants.join(", ")}` };
    }
    const granted = this.broker ? grantedTools(this.broker, spec) : null;
    const transcript: string[] = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
    let last: Observation | null = null;
    try {
      for (;;) {
        if (spec.signal.aborted) return { status: "aborted", output: null, transcript: transcript.join("\n"), usage };
        const step = this.llm.next(last);
        if ("final" in step) {
          transcript.push(`final: ${JSON.stringify(step.final)}`);
          return { status: "completed", output: step.final, transcript: transcript.join("\n"), usage };
        }
        const tool = RUNNER_TOOLS.find((t) => t.name === step.tool && spec.tools.some((s) => s.name === t.name));
        const result: ToolResult = tool
          ? await tool.run(step.input, ctx)
          : granted
            ? brokerResult(await granted.call(step.tool, step.input))
            : { ok: false, error: `tool ${step.tool} is not available to this run` };
        transcript.push(`tool_use ${step.tool} ${JSON.stringify(step.input)}`);
        transcript.push(`tool_result ${JSON.stringify(result)}`);
        last = { tool: step.tool, input: step.input, result };
      }
    } catch (err) {
      return { status: "failed", output: null, transcript: transcript.join("\n"), usage, error: String(err) };
    }
  }
}

/** A broker result in the shared tools' result shape, as the model would see it. */
function brokerResult(r: Awaited<ReturnType<ToolBroker["call"]>>): ToolResult {
  return r.ok ? { ok: true, content: JSON.stringify(r.content) } : { ok: false, error: `${r.error_code}: ${r.message}` };
}
