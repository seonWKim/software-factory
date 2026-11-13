import { CLASSIFY_SYSTEM } from "../../src/core/classify-message.js";
import type { LLMRequest, LLMResponse } from "../../src/interfaces/llm-provider.js";

// Fake LLMs written for the interpreter answer the classifier in front of it (design 04-gate-commands) with this,
// so their scripted interpreter answers stay as they were.

/** `label` as the classifier's answer when `req` is the classifier's request; else null (the request is the interpreter's). */
export function classifierAnswer(req: LLMRequest, label = "command"): LLMResponse | null {
  return req.system === CLASSIFY_SYSTEM ? { text: label, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } } : null;
}
