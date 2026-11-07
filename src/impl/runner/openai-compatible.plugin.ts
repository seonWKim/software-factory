import { definePlugin } from "../../plugin-api.js";
import { OPENAI_COMPATIBLE_API_KEY } from "../llm/openai-compatible-llm-provider.js";
import { OpenAICompatibleRunner } from "./openai-compatible-runner.js";

// Not a default: selected only by name, `"plugins": { "runner": "openai-compatible" }`. create() never throws
// when the openai_compatible block is absent; a run fails naming it instead. It exposes no broker tools, so it
// takes no broker or scanner.
export default definePlugin({
  kind: "runner",
  name: "openai-compatible",
  secrets: [{ name: OPENAI_COMPATIBLE_API_KEY, purpose: "API key for the openai_compatible chat completions endpoint the agent loop calls (sent as a Bearer token)" }],
  create: (c) => new OpenAICompatibleRunner({ sandbox: c.sandbox, secrets: c.secrets, config: c.loaded.file.openai_compatible }),
});
