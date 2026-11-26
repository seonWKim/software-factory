// One model call (e.g. classification), optionally offering tools: the reply may ask for tool calls, and the caller
// runs them and sends each result back as a `tool` message in its next call. The provider never runs a tool.
// Agent loops in a sandbox go through AgentRunner.
// First impl: Anthropic, local transport = Claude Code CLI on the subscription; later API / gateway.

/** A tool call the model asked for: `arguments` is the JSON text the model wrote, unparsed. */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool the model may call: `parameters` is its arguments' JSON schema. */
export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** An assistant message's tool calls, sent back as they were returned. */
  tool_calls?: readonly LLMToolCall[];
  /** A `tool` message: the id of the call whose result `content` is. */
  tool_call_id?: string;
}

export interface LLMRequest {
  model_class: "cheap" | "standard" | "strong";
  system?: string;
  messages: readonly LLMMessage[];
  max_tokens: number;
  output_schema?: Record<string, unknown>;
  /** Tools the model may call. A provider without tool support answers stop_reason "error" and makes no call. */
  tools?: readonly LLMTool[];
  /** Environment label (design §8). The provider refuses "prod" data. */
  data_env: "test" | "prod";
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  /** Parsed JSON when output_schema was given. */
  parsed?: unknown;
  /** The tool calls the reply asks for; absent or empty: none. */
  tool_calls?: LLMToolCall[];
  stop_reason: "end" | "max_tokens" | "refused" | "error";
  usage: { input_tokens: number; output_tokens: number; cost_usd: number | null };
  /** The chain member that answered (design 2026-11-07): its plugin name. Set by a fallback chain. */
  served_by?: string;
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
}
