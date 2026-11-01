// Single model calls without tools (e.g. classification). Agent loops go through AgentRunner.
// First impl: Anthropic, local transport = Claude Code CLI on the subscription; later API / gateway.

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  model_class: "cheap" | "standard" | "strong";
  system?: string;
  messages: readonly LLMMessage[];
  max_tokens: number;
  output_schema?: Record<string, unknown>;
  /** Environment label (design §8). The provider refuses "prod" data. */
  data_env: "test" | "prod";
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  /** Parsed JSON when output_schema was given. */
  parsed?: unknown;
  stop_reason: "end" | "max_tokens" | "refused" | "error";
  usage: { input_tokens: number; output_tokens: number; cost_usd: number | null };
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
}
