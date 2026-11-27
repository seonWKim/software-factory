import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse, LLMTool, LLMToolCall } from "../../interfaces/llm-provider.js";
import type { SecretStore } from "../../interfaces/secret-store.js";
import { runProcess } from "../process/run-process.js";
import { buildAgentEnv, harnessCredential } from "../runner/claude-code-runner.js";

/**
 * Anthropic via the Claude Code CLI on the subscription login (D2). One turn. The CLI runs with no tools of its own
 * (`--tools ""`), so offered tools are carried in the reply's shape (docs/plugins/llm-provider.md): the system prompt
 * lists each tool with its arguments' schema, `--json-schema` makes the reply `{ answer, tool_calls }`, and a reply
 * with tool calls is returned as `tool_calls` for the caller to run. Earlier tool calls and their results are sent as
 * text in the prompt. The provider never runs a tool. Tools with an output schema are refused (stop_reason "error").
 */
export class ClaudeCliLLMProvider implements LLMProvider {
  constructor(
    private readonly opts: {
      secrets: SecretStore;
      claudeConfigDir: string;
      workDir: string;
      models: { cheap: string; standard: string; strong: string };
      claudeBin?: string;
    },
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: null as number | null };
    if (req.data_env === "prod") return { text: "", stop_reason: "refused", usage };
    const tools = req.tools ?? [];
    if (tools.length > 0 && req.output_schema !== undefined) {
      return { text: "claude-cli: tools with an output schema are not supported in one call", stop_reason: "error", usage };
    }

    await mkdir(join(this.opts.workDir, "tmp"), { recursive: true });
    const env = buildAgentEnv({ env_allowlist: {} }, await harnessCredential(this.opts.secrets), {
      home: this.opts.workDir,
      claudeConfigDir: this.opts.claudeConfigDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
    const prompt = req.messages.map(promptPart).join("\n\n");
    const system = tools.length > 0 ? [req.system, toolsSection(tools)].filter((x) => x).join("\n\n") : req.system;
    const schema = tools.length > 0 ? toolReplySchema(tools) : req.output_schema;
    const args = [
      this.opts.claudeBin ?? "claude", "-p",
      "--output-format", "json",
      "--tools", "",
      "--setting-sources", "project",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", this.opts.models[req.model_class],
      ...(system ? ["--system-prompt", system] : []),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    ];
    const r = await runProcess(args, {
      cwd: this.opts.workDir,
      env,
      stdin: prompt,
      ...(req.signal !== undefined && { signal: req.signal }),
    });
    try {
      const out = JSON.parse(r.stdout) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      usage.input_tokens = out.usage?.input_tokens ?? 0;
      usage.output_tokens = out.usage?.output_tokens ?? 0;
      usage.cost_usd = out.total_cost_usd ?? null;
      if (tools.length > 0 && !out.is_error) return toolReply(out.structured_output, usage);
      return {
        text: out.result ?? "",
        ...(out.structured_output !== undefined && { parsed: out.structured_output }),
        stop_reason: out.is_error ? "error" : "end",
        usage,
      };
    } catch {
      return { text: "", stop_reason: "error", usage };
    }
  }
}

/** One message as prompt text; an assistant's tool calls and a tool's result are written out, so a later call sees them. */
function promptPart(m: LLMMessage): string {
  if (m.role === "tool") return `TOOL RESULT (${m.tool_call_id ?? "?"}):\n${m.content}`;
  const calls = m.tool_calls ?? [];
  if (m.role === "assistant" && calls.length > 0) {
    const asked = calls.map((c) => ({ id: c.id, name: c.name, arguments: parsedOr(c.arguments) }));
    return `ASSISTANT (tool calls):\n${m.content ? `${m.content}\n` : ""}${JSON.stringify(asked)}`;
  }
  return `${m.role.toUpperCase()}:\n${m.content}`;
}

const parsedOr = (text: string): unknown => {
  try {
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return text;
  }
};

/** The system prompt's part that names the tools and how to ask for them in the reply's shape. */
export function toolsSection(tools: readonly LLMTool[]): string {
  return [
    "## Tools",
    "The caller runs these tools for you. They are not in your own tool list: calling one by name fails with \"No such tool available\", so never do that.",
    "To use one, end your turn with your structured output holding it in tool_calls (its name and its arguments object) and answer empty; you may list several. The caller runs each one and sends its result back in a TOOL RESULT message in the next turn; then answer, or ask for more tools.",
    "When you have the answer, put it in answer and leave tool_calls empty. Never say a tool is unavailable: ask for it in tool_calls.",
    ...tools.map((t) => `- ${t.name}: ${t.description} Arguments schema: ${JSON.stringify(t.parameters)}`),
  ].join("\n");
}

/** The reply's shape when tools are offered: an answer, or tool calls naming only offered tools. */
export function toolReplySchema(tools: readonly LLMTool[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      answer: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string", enum: tools.map((t) => t.name) }, arguments: { type: "object" } },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["answer", "tool_calls"],
    additionalProperties: false,
  };
}

/** The CLI's structured output as an answer: its text, or its tool calls each with a new id; another shape is "error". */
function toolReply(out: unknown, usage: LLMResponse["usage"]): LLMResponse {
  const o = out as { answer?: unknown; tool_calls?: unknown } | undefined;
  const calls = o?.tool_calls;
  const shaped = typeof o === "object" && o !== null && typeof o.answer === "string" && Array.isArray(calls)
    && calls.every((c) => typeof c === "object" && c !== null && typeof (c as { name?: unknown }).name === "string");
  if (!shaped) return { text: "claude-cli: the reply was not an answer or tool calls", stop_reason: "error", usage };
  const tool_calls: LLMToolCall[] = (calls as { name: string; arguments?: unknown }[]).map((c) => ({
    id: `call_${randomUUID()}`,
    name: c.name,
    arguments: JSON.stringify(c.arguments ?? {}),
  }));
  return { text: o.answer as string, ...(tool_calls.length > 0 && { tool_calls }), stop_reason: "end", usage };
}
