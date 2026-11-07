import { type ToolContext, type ToolResult, type ToolSpec, guardPolicy } from "../../core/tools/index.js";
import {
  type AgentRunResult, type AgentRunSpec, type AgentRunner, PROVIDER_SETUP, toolsNotExposedMessage,
} from "../../interfaces/agent-runner.js";
import type { Sandbox } from "../../interfaces/sandbox.js";
import type { SecretStore } from "../../interfaces/secret-store.js";
import { OPENAI_COMPATIBLE_API_KEY } from "../llm/openai-compatible-llm-provider.js";
import { type ChatMessage, type ChatRequest, type ChatToolCall, chatCompletion } from "../openai/chat-client.js";
import type { OpenAICompatibleConfig } from "../openai/config.js";
import { schemaMismatches, unsupportedKeyword } from "./output-schema.js";

// An AgentRunner with no harness of its own: it runs a chat-completions tool loop against any OpenAI-style
// endpoint (`openai_compatible.base_url`), through the shared client in src/impl/openai/. Every tool call goes
// through `ToolSpec.run` from src/core/tools with `guardPolicy`, so the file guards (deny_paths, `.env`, the
// workdir and writable_paths bounds) come from the shared tools; this runner never reads a file itself.
//
// The API key is read from the SecretStore once per run and given only to the chat client. It is scrubbed
// from every text this runner returns or sends back to the model, and never reaches a tool's environment.

/** Tool rounds a run may take. A model that still asks for tools after this many ends the run `failed`. */
export const MAX_TOOL_ROUNDS = 25;

/**
 * The Bash rule (issue #194): Bash is offered when the spec offers it, but every call is refused before it runs.
 * Bash is not path-checked, and no sandbox denies reads at OS level yet (G3; the Sandbox interface cannot report
 * one), so a shell could read the secret file or the G6 canary.
 */
export const BASH_REFUSAL =
  "refused: Bash does not run under the openai-compatible runner. Bash is not path-checked and no sandbox denies " +
  "reads at OS level yet, so a shell could read secret files. Use Read, Glob, Grep, Write and Edit instead.";

/** Prefix of `error` on a completed run whose final answer is not JSON or does not match output_schema. */
export const INVALID_OUTPUT = "invalid_output";
/** Prefix of `error` on a run that went past MAX_TOOL_ROUNDS (the worker records it as agent_failed). */
export const AGENT_FAILED = "agent_failed";

export interface OpenAICompatibleRunnerOptions {
  sandbox: Sandbox;
  secrets: SecretStore;
  /** The checked `openai_compatible` block; undefined when config has none (a run then fails, naming it). */
  config: OpenAICompatibleConfig | undefined;
  /** Milliseconds since the epoch, for Retry-After in seconds. Absent: Date.now. */
  now?: () => number;
}

type Usage = AgentRunResult["usage"] & { model: string | null };

function redact(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("[redacted]");
}

/** The tool list of the request: exactly `tools`, by name, in order. */
export function requestTools(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

/** What the system message adds about the final answer. */
function answerRules(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "";
  return (
    "\n\n## Final answer\nWhen you are done, reply with no tool call and only a JSON object (no prose, no code fence) " +
    `that matches this JSON Schema:\n${JSON.stringify(schema)}`
  );
}

/** The final text as JSON: the text itself, or the inside of one surrounding ``` fence. */
function parseAnswer(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(t);
  try {
    return { ok: true, value: JSON.parse(fenced ? fenced[1]! : t) };
  } catch {
    return { ok: false };
  }
}

function toolText(r: ToolResult): string {
  if (!r.ok) return `error: ${r.error}`;
  return r.truncated ? `${r.content}\n[output truncated]` : r.content;
}

export class OpenAICompatibleRunner implements AgentRunner {
  /** Broker tools are never exposed: a run with tool_grants fails. */
  readonly exposes_tools = false;

  constructor(private readonly opts: OpenAICompatibleRunnerOptions) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
    const lines: string[] = [];
    let key = "";
    let lastNote: string | undefined;
    const result = (status: AgentRunResult["status"], extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
      status,
      output: null,
      transcript: redact(lines.join("\n"), key),
      usage,
      ...(lastNote !== undefined && { last_note: redact(lastNote, key) }),
      ...extra,
      ...(extra.error !== undefined && { error: redact(extra.error, key) }),
    });

    // Refusals before any model call.
    if (spec.tool_grants.length > 0) return result("failed", { error: toolsNotExposedMessage(spec.tool_grants) });
    const config = this.opts.config;
    if (!config) return result("failed", { error: "openai-compatible: the openai_compatible block is missing from factory.config.json (base_url and models)" });
    if (spec.output_schema) {
      const bad = unsupportedKeyword(spec.output_schema);
      if (bad) return result("failed", { error: `openai-compatible: output_schema is not supported: ${bad}` });
    }
    key = (await this.opts.secrets.get(OPENAI_COMPATIBLE_API_KEY))?.reveal() ?? "";
    if (key === "") return result("failed", { error: `openai-compatible: ${OPENAI_COMPATIBLE_API_KEY} is not set (run: npm run setup)` });
    if (spec.signal.aborted) return result("aborted");

    // One signal for the model calls and the tools: the caller's abort, or timeout_ms.
    const stop = new AbortController();
    let timedOut = false;
    const onAbort = () => stop.abort();
    spec.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, spec.timeout_ms);
    const ended = () => result(timedOut && !spec.signal.aborted ? "timed_out" : "aborted");

    // Built from the spec only: every path and env check is the shared tools'.
    const policy = guardPolicy({
      workdir: spec.sandbox.workdir,
      deny_paths: spec.deny_paths,
      writable_paths: spec.writable_paths,
      env_allowlist: spec.env_allowlist,
    });
    const ctx: ToolContext = { sandbox: this.opts.sandbox, handle: spec.sandbox, policy, signal: stop.signal };
    const tools = requestTools(spec.tools);
    const model = config.models[spec.model_class];
    const messages: ChatMessage[] = [
      { role: "system", content: redact(spec.system_prompt + answerRules(spec.output_schema), key) },
      { role: "user", content: redact(spec.prompt, key) },
    ];
    let sent = 0;

    try {
      for (let round = 0; ; round++) {
        if (stop.signal.aborted) return ended();
        // The request as sent, minus the messages an earlier line already holds. No header: the key is only there.
        lines.push(JSON.stringify({ type: "request", round, model, tools: spec.tools.map((t) => t.name), messages: messages.slice(sent) }));
        sent = messages.length;
        const request: ChatRequest = { model, messages, ...(tools.length > 0 && { tools }) };
        const r = await chatCompletion({
          baseUrl: config.base_url,
          apiKey: key,
          request,
          signal: stop.signal,
          ...(this.opts.now && { now: this.opts.now }),
        });
        if (!r.ok) {
          lines.push(JSON.stringify({ type: "error", round, code: r.code, ...(r.status !== undefined && { status: r.status }), message: r.message }));
          if (r.code === "aborted" || stop.signal.aborted) return ended();
          if (r.code === "rate_limited") return result("rate_limited", { error: r.message, ...(r.reset_at && { reset_at: r.reset_at }) });
          if (r.code === PROVIDER_SETUP) return result("failed", { code: PROVIDER_SETUP, error: `openai-compatible: ${r.code}: ${r.message}` });
          return result("failed", { error: `openai-compatible: ${r.code}: ${r.message}` });
        }
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        if (r.model) usage.model = r.model;
        lines.push(JSON.stringify({ type: "response", round, model: r.model, text: r.text, tool_calls: r.tool_calls, usage: r.usage }));

        if (r.tool_calls.length === 0) return this.finish(spec, r.text, result);
        if (r.text.trim()) lastNote = r.text;
        if (round >= MAX_TOOL_ROUNDS) {
          return result("failed", { error: `${AGENT_FAILED}: the model still asked for tools after ${MAX_TOOL_ROUNDS} tool rounds` });
        }

        messages.push({ role: "assistant", content: r.text === "" ? null : r.text, tool_calls: r.tool_calls });
        for (const call of r.tool_calls) {
          const content = redact(toolText(await this.callTool(spec.tools, call, ctx)), key);
          lines.push(JSON.stringify({ type: "tool_result", round, id: call.id, name: call.function.name, content }));
          messages.push({ role: "tool", tool_call_id: call.id, content });
          if (stop.signal.aborted) return ended();
        }
      }
    } finally {
      clearTimeout(timer);
      spec.signal.removeEventListener("abort", onAbort);
    }
  }

  /** One tool call: a tool of the spec, run by the shared module, or a refusal. Never throws. */
  private async callTool(tools: readonly ToolSpec[], call: ChatToolCall, ctx: ToolContext): Promise<ToolResult> {
    const name = call.function.name;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { ok: false, error: `tool ${name} is not available to this run` };
    if (tool.capability === "exec") return { ok: false, error: BASH_REFUSAL };
    let input: unknown;
    try {
      input = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
    } catch {
      return { ok: false, error: `${name}: the arguments are not JSON` };
    }
    return tool.run(input, ctx);
  }

  /** The final answer: parsed and checked against output_schema. A bad answer is `completed` with no output. */
  private finish(spec: AgentRunSpec, text: string, result: (s: AgentRunResult["status"], e?: Partial<AgentRunResult>) => AgentRunResult) {
    if (!spec.output_schema) return result("completed", { output: text });
    const parsed = parseAnswer(text);
    if (!parsed.ok) return result("completed", { error: `${INVALID_OUTPUT}: the final answer is not JSON` });
    const mismatches = schemaMismatches(spec.output_schema, parsed.value);
    if (mismatches.length > 0) {
      return result("completed", { error: `${INVALID_OUTPUT}: the final answer does not match output_schema: ${mismatches.slice(0, 3).join("; ")}` });
    }
    return result("completed", { output: parsed.value });
  }
}
