import type { LLMProvider, LLMRequest, LLMResponse } from "../interfaces/llm-provider.js";
import type { ChainMember } from "./fallback-runner.js";

// The LLMProvider fallback chain (design 2026-11-07): `plugins.llm` lists several providers, tried in order.
// A thrown error, or an "error" stop with no output, falls over; any other answer (also refused or max_tokens)
// is the answer. No state between calls: each call starts at the first member.

export class FallbackLLM implements LLMProvider {
  constructor(private readonly members: readonly ChainMember<LLMProvider>[]) {
    if (members.length === 0) throw new Error("FallbackLLM needs at least one provider");
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const failures: string[] = [];
    const usage: LLMResponse["usage"] = { input_tokens: 0, output_tokens: 0, cost_usd: null };
    let last: LLMResponse | undefined;
    let thrown: unknown;
    for (const m of this.members) {
      if (req.signal?.aborted) break;
      try {
        const r = await m.impl.complete(req);
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        if (r.usage.cost_usd !== null) usage.cost_usd = (usage.cost_usd ?? 0) + r.usage.cost_usd;
        last = { ...r, usage, served_by: m.name };
        thrown = undefined;
        if (r.stop_reason !== "error" || r.usage.output_tokens > 0) return last;
        failures.push(`${m.name}: error stop${r.text ? `: ${r.text.slice(0, 200)}` : ""}`);
      } catch (err) {
        thrown = err;
        failures.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const summary = `every LLM provider failed: ${failures.join("; ")}`;
    // The last member decides the shape: it threw, so the chain throws; it answered "error", so that answer.
    if (thrown !== undefined || !last) throw new Error(summary, { cause: thrown });
    return { ...last, text: last.text || summary };
  }
}
