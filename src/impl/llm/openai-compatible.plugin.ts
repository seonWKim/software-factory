import { definePlugin } from "../../plugin-api.js";
import { OPENAI_COMPATIBLE_API_KEY, OpenAICompatibleLLMProvider } from "./openai-compatible-llm-provider.js";

// Not a default: selected only by name, `"plugins": { "llm": "openai-compatible" }`. create() never throws
// when the openai_compatible block is absent; complete() reports it instead.
export default definePlugin({
  kind: "llm",
  name: "openai-compatible",
  secrets: [{ name: OPENAI_COMPATIBLE_API_KEY, purpose: "API key for the openai_compatible chat completions endpoint (sent as a Bearer token)" }],
  create: (c) => new OpenAICompatibleLLMProvider({ secrets: c.secrets, config: c.loaded.file.openai_compatible }),
});
