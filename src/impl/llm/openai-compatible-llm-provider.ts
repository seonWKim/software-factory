import type { LLMProvider, LLMRequest, LLMResponse } from "../../interfaces/llm-provider.js";
import { type SecretName, type SecretStore, secretName } from "../../interfaces/secret-store.js";
import { type ChatMessage, type ChatRequest, chatCompletion } from "../openai/chat-client.js";
import type { OpenAICompatibleConfig } from "../openai/config.js";
import { checkSchema, validateAgainstSchema } from "../openai/json-schema.js";

export const OPENAI_COMPATIBLE_API_KEY: SecretName = secretName("OPENAI_COMPATIBLE_API_KEY");

/**
 * Any OpenAI-style chat completions endpoint (`openai_compatible.base_url`), through the shared client in
 * src/impl/openai/. No tools, one request per call, no retries. The API key is read from the SecretStore on
 * each call, never from the environment. An output_schema is sent as `response_format` json_schema (strict)
 * and the reply is checked against it here, so a provider that ignores response_format still yields "error".
 *
 * The shared client exposes no finish_reason and no cost: stop_reason is "end" on any 2xx reply (never
 * "max_tokens") and cost_usd is always null.
 */
export class OpenAICompatibleLLMProvider implements LLMProvider {
  constructor(
    private readonly opts: {
      secrets: SecretStore;
      /** The checked `openai_compatible` block; undefined when config has none (complete() then reports it). */
      config: OpenAICompatibleConfig | undefined;
    },
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: null as number | null };
    const error = (text: string): LLMResponse => ({ text, stop_reason: "error", usage });
    if (req.data_env === "prod") return { text: "", stop_reason: "refused", usage };

    const config = this.opts.config;
    if (!config) return error("openai-compatible: the openai_compatible block is missing from factory.config.json (base_url and models)");
    if (req.output_schema !== undefined) {
      try {
        checkSchema(req.output_schema);
      } catch (err) {
        return error(`openai-compatible: output_schema is not supported: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const key = await this.opts.secrets.get(OPENAI_COMPATIBLE_API_KEY);
    const apiKey = key?.reveal() ?? "";
    if (apiKey === "") return error(`openai-compatible: ${OPENAI_COMPATIBLE_API_KEY} is not set (run: npm run setup)`);

    const messages: ChatMessage[] = [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const request: ChatRequest = {
      model: config.models[req.model_class],
      messages,
      max_tokens: req.max_tokens,
      ...(req.output_schema !== undefined && {
        response_format: { type: "json_schema", json_schema: { name: "output", schema: req.output_schema, strict: true } },
      }),
    };
    const r = await chatCompletion({
      baseUrl: config.base_url,
      apiKey,
      request,
      ...(req.signal !== undefined && { signal: req.signal }),
    });
    if (!r.ok) return error(`openai-compatible: ${r.code}: ${r.message}`);

    usage.input_tokens = r.usage.input_tokens;
    usage.output_tokens = r.usage.output_tokens;
    if (req.output_schema === undefined) return { text: r.text, stop_reason: "end", usage };

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return error("openai-compatible: the reply is not JSON, though an output_schema was given");
    }
    const check = validateAgainstSchema(req.output_schema, parsed);
    if (!check.ok) {
      const where = check.mismatches.slice(0, 3).map((m) => `${m.path} ${m.message}`).join("; ");
      return error(`openai-compatible: the reply does not match the output_schema: ${where}`);
    }
    return { text: r.text, parsed, stop_reason: "end", usage };
  }
}
