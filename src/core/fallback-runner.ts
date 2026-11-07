import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../interfaces/agent-runner.js";
import { toolsNotExposedMessage } from "../interfaces/agent-runner.js";

// The AgentRunner fallback chain (design 2026-11-07): `plugins.runner` lists several runners, tried in order.
// No vendor code and no state between runs: every run starts at the first member, so a replica never needs to
// know that another found the primary down.

export interface ChainMember<T> {
  /** The plugin name, as config lists it. */
  name: string;
  impl: T;
}

export type Fallover = NonNullable<AgentRunResult["fallbacks"]>[number];

/** The separator line between two members' transcripts in one run's transcript. */
export function transcriptSeparator(name: string): string {
  return `\n----- runner fallback: ${name} -----\n`;
}

/**
 * Whether the next member may take the run. Only when this member did no real work: a rate limit, a stall with no
 * write-capable tool call (`did_work`; a runner that does not report it: no model output), or a failure with no
 * model output (an up-front refusal such as a missing secret or config fails the same way, and so does
 * `provider_setup`: the provider refused this member's quota, key or model, so the next may still answer). A stall
 * after edits stands, so no next member gets a half-edited workdir (design §5 Restarts). Completed (also with
 * invalid output), timed out, aborted, or failed after output: the result stands.
 */
export function canFallOver(r: AgentRunResult): boolean {
  if (r.status === "rate_limited") return true;
  if (r.status === "stalled") return r.did_work === undefined ? r.usage.output_tokens === 0 : !r.did_work;
  if (r.status === "failed") return r.usage.output_tokens === 0;
  return false;
}

function reasonOf(r: AgentRunResult): string {
  return r.error ? `${r.status}: ${r.error}` : r.status;
}

export class FallbackRunner implements AgentRunner {
  readonly exposes_tools: boolean;

  constructor(private readonly members: readonly ChainMember<AgentRunner>[]) {
    if (members.length === 0) throw new Error("FallbackRunner needs at least one runner");
    this.exposes_tools = members.some((m) => m.impl.exposes_tools === true);
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    // A run with granted tools skips members that cannot expose them, rather than fail at each.
    const members = spec.tool_grants.length > 0 ? this.members.filter((m) => m.impl.exposes_tools === true) : this.members;
    if (members.length === 0) {
      return { status: "failed", output: null, transcript: "", usage: zeroUsage(), error: toolsNotExposedMessage(spec.tool_grants) };
    }
    const tried: { name: string; result: AgentRunResult }[] = [];
    const fallbacks: Fallover[] = [];
    for (const [i, m] of members.entries()) {
      const result = await m.impl.run(await this.specFor(m, spec));
      tried.push({ name: m.name, result });
      const next = members[i + 1];
      if (!next || spec.signal.aborted || !canFallOver(result)) break;
      fallbacks.push({ from: m.name, to: next.name, reason: reasonOf(result) });
    }
    return combine(tried, fallbacks, tried.length === members.length);
  }

  /** True if any member stores the session: the one that served the paused run resumes it. */
  async hasSession(id: string): Promise<boolean> {
    for (const m of this.members) if (m.impl.hasSession && (await m.impl.hasSession(id).catch(() => false))) return true;
    return false;
  }

  async removeSession(id: string): Promise<void> {
    for (const m of this.members) await m.impl.removeSession?.(id);
  }

  /** A resumed session continues only on a member that stores it; another member starts it new. */
  private async specFor(m: ChainMember<AgentRunner>, spec: AgentRunSpec): Promise<AgentRunSpec> {
    if (!spec.session?.resume) return spec;
    const has = m.impl.hasSession ? await m.impl.hasSession(spec.session.id).catch(() => false) : false;
    return has ? spec : { ...spec, session: { id: spec.session.id, resume: false } };
  }
}

function zeroUsage(): AgentRunResult["usage"] {
  return { input_tokens: 0, output_tokens: 0, cost_usd: null };
}

/**
 * The run's result: the last member's, with the usage of every member tried summed, every transcript joined,
 * and `served_by` naming the last member. When every member fell over, the error names each failure in order;
 * a rate limit keeps the earliest `reset_at` any member reported.
 */
function combine(tried: readonly { name: string; result: AgentRunResult }[], fallbacks: Fallover[], exhausted: boolean): AgentRunResult {
  const last = tried[tried.length - 1]!;
  const usage = zeroUsage();
  let cache_read = 0;
  let cache_write = 0;
  for (const { result: r } of tried) {
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    cache_read += r.usage.cache_read_tokens ?? 0;
    cache_write += r.usage.cache_write_tokens ?? 0;
    if (r.usage.cost_usd !== null) usage.cost_usd = (usage.cost_usd ?? 0) + r.usage.cost_usd;
  }
  if (cache_read > 0) usage.cache_read_tokens = cache_read;
  if (cache_write > 0) usage.cache_write_tokens = cache_write;
  if (last.result.usage.model !== undefined) usage.model = last.result.usage.model;
  const transcript =
    tried.length === 1 ? last.result.transcript : tried.map((t) => `${transcriptSeparator(t.name)}${t.result.transcript}`).join("");
  const out: AgentRunResult = { ...last.result, usage, transcript, served_by: last.name };
  if (fallbacks.length > 0) out.fallbacks = fallbacks;
  if (tried.length > 1 && exhausted && canFallOver(last.result)) {
    out.error = `every runner failed: ${tried.map((t) => `${t.name}: ${reasonOf(t.result)}`).join("; ")}`;
    if (last.result.status === "rate_limited") {
      const resets = tried.map((t) => t.result.reset_at).filter((r): r is string => r !== undefined && !Number.isNaN(Date.parse(r)));
      resets.sort((a, b) => Date.parse(a) - Date.parse(b));
      if (resets[0]) out.reset_at = resets[0];
    }
  }
  return out;
}
