import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FallbackLLM } from "../src/core/fallback-llm.js";
import { FallbackRunner, transcriptSeparator } from "../src/core/fallback-runner.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { type AgentRunResult, type AgentRunSpec, type AgentRunner, toolsNotExposedMessage } from "../src/interfaces/agent-runner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { SandboxHandle } from "../src/interfaces/sandbox.js";
import { pipeline } from "./helpers/fakes.js";
import { REGISTRY, declaredSecretNames, selectPlugins, selectedLlms, selectedRunners } from "../src/plugins.js";

// The runner and LLM fallback chains (design 2026-11-07): `plugins.runner` / `plugins.llm` list several plugins,
// tried in order; a member that did no work gives the call to the next one.

const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;

const usage = (output_tokens = 0, cost_usd: number | null = null) => ({ input_tokens: 10, output_tokens, cost_usd });
const res = (status: AgentRunResult["status"], extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
  status, output: null, transcript: `${status} transcript`, usage: usage(), ...extra,
});

class ScriptedRunner implements AgentRunner {
  readonly specs: AgentRunSpec[] = [];
  removed: string[] = [];
  constructor(
    private readonly result: AgentRunResult,
    readonly exposes_tools = false,
    private readonly sessions: string[] = [],
  ) {}
  async run(spec: AgentRunSpec) {
    this.specs.push(spec);
    return this.result;
  }
  async hasSession(id: string) {
    return this.sessions.includes(id);
  }
  async removeSession(id: string) {
    this.removed.push(id);
  }
}

function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    run_id: "run_1" as RunId, work_item_id: "wi_1" as WorkItemId, role: "implement", sandbox: {} as SandboxHandle,
    system_prompt: "", prompt: "do it", tools: [], tool_grants: [], lease_token: 1, env_allowlist: {}, deny_paths: [],
    writable_paths: [], model_class: "standard", timeout_ms: 1000, signal: new AbortController().signal, ...over,
  };
}

const chain = (...rs: ScriptedRunner[]) => new FallbackRunner(rs.map((impl, i) => ({ name: ["claude-code", "openai-compatible", "third"][i]!, impl })));

describe("FallbackRunner: falls over only when the member did no work", () => {
  const fallsOver: [string, AgentRunResult][] = [
    ["rate_limited", res("rate_limited", { reset_at: "2026-11-07T10:00:00.000Z" })],
    ["stalled with no output", res("stalled")],
    ["failed with no output (an up-front refusal: missing secret)", res("failed", { error: "OPENAI_COMPATIBLE_API_KEY is not set" })],
  ];
  for (const [what, first] of fallsOver) {
    it(`${what}: the second member runs and its result is served`, async () => {
      const a = new ScriptedRunner(first);
      const b = new ScriptedRunner(res("completed", { output: { ok: true }, usage: usage(5, 0.02) }));
      const r = await chain(a, b).run(spec());
      expect(b.specs).toHaveLength(1);
      expect(r.status).toBe("completed");
      expect(r.output).toEqual({ ok: true });
      expect(r.served_by).toBe("openai-compatible");
      expect(r.fallbacks).toEqual([{ from: "claude-code", to: "openai-compatible", reason: expect.stringContaining(first.status) }]);
    });
  }

  const stands: [string, AgentRunResult][] = [
    ["completed", res("completed")],
    ["completed with invalid output", res("completed", { error: "invalid_output: not JSON", usage: usage(3) })],
    ["failed after work", res("failed", { usage: usage(40) })],
    ["stalled after output", res("stalled", { usage: usage(40) })],
    ["timed_out", res("timed_out")],
    ["aborted", res("aborted")],
  ];
  for (const [what, first] of stands) {
    it(`${what}: the result stands and no other member runs`, async () => {
      const a = new ScriptedRunner(first);
      const b = new ScriptedRunner(res("completed"));
      const r = await chain(a, b).run(spec());
      expect(b.specs).toHaveLength(0);
      expect(r.status).toBe(first.status);
      expect(r.served_by).toBe("claude-code");
      expect(r.fallbacks).toBeUndefined();
      expect(r.transcript).toBe(first.transcript);
    });
  }

  it("a lost lease (aborted signal) stops the chain even after a fall-over-able result", async () => {
    const ac = new AbortController();
    ac.abort();
    const b = new ScriptedRunner(res("completed"));
    const r = await chain(new ScriptedRunner(res("stalled")), b).run(spec({ signal: ac.signal }));
    expect(b.specs).toHaveLength(0);
    expect(r.status).toBe("stalled");
    expect(r.error).toBeUndefined();
  });
});

describe("FallbackRunner: the combined result", () => {
  it("sums the usage of every member tried and joins their transcripts with a separator line", async () => {
    const a = new ScriptedRunner(res("rate_limited", { usage: { input_tokens: 7, output_tokens: 0, cost_usd: 0.01, cache_read_tokens: 2 } }));
    const b = new ScriptedRunner(res("completed", { usage: { input_tokens: 5, output_tokens: 9, cost_usd: null, model: "m-standard" } }));
    const r = await chain(a, b).run(spec());
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 9, cost_usd: 0.01, cache_read_tokens: 2, model: "m-standard" });
    expect(r.transcript).toBe(
      `${transcriptSeparator("claude-code")}rate_limited transcript${transcriptSeparator("openai-compatible")}completed transcript`,
    );
  });

  it("every member failing: the last result, an error naming each failure in order", async () => {
    const r = await chain(
      new ScriptedRunner(res("failed", { error: "no key" })),
      new ScriptedRunner(res("stalled")),
      new ScriptedRunner(res("failed", { error: "no config" })),
    ).run(spec());
    expect(r.status).toBe("failed");
    expect(r.served_by).toBe("third");
    expect(r.error).toBe("every runner failed: claude-code: failed: no key; openai-compatible: stalled; third: failed: no config");
    expect(r.fallbacks).toHaveLength(2);
  });

  it("a rate limit from the last member stays rate_limited, with the earliest reset_at", async () => {
    const r = await chain(
      new ScriptedRunner(res("rate_limited", { reset_at: "2026-11-07T09:00:00.000Z" })),
      new ScriptedRunner(res("rate_limited", { reset_at: "2026-11-07T12:00:00.000Z" })),
    ).run(spec());
    expect(r.status).toBe("rate_limited");
    expect(r.reset_at).toBe("2026-11-07T09:00:00.000Z");
    expect(r.error).toMatch(/^every runner failed: claude-code: rate_limited; openai-compatible: rate_limited$/);
  });
});

describe("FallbackRunner: tools and sessions", () => {
  it("exposes tools if any member does, and a run with grants skips members that cannot", async () => {
    const a = new ScriptedRunner(res("completed"), false);
    const b = new ScriptedRunner(res("completed"), true);
    const c = chain(a, b);
    expect(c.exposes_tools).toBe(true);
    const r = await c.run(spec({ tool_grants: ["github.read_issue"] }));
    expect(a.specs).toHaveLength(0);
    expect(r.served_by).toBe("openai-compatible");
    expect(r.fallbacks).toBeUndefined();
  });

  it("no member exposing tools: the chain says so and fails a granted run without calling any member", async () => {
    const a = new ScriptedRunner(res("completed"));
    const c = chain(a, new ScriptedRunner(res("completed")));
    expect(c.exposes_tools).toBe(false);
    const r = await c.run(spec({ tool_grants: ["github.read_issue"] }));
    expect(r.status).toBe("failed");
    expect(r.error).toBe(toolsNotExposedMessage(["github.read_issue"]));
    expect(a.specs).toHaveLength(0);
  });

  it("a resumed session continues on the member that stores it; another member starts it new", async () => {
    const a = new ScriptedRunner(res("rate_limited"));
    const b = new ScriptedRunner(res("completed"), false, ["s1"]);
    const c = chain(a, b);
    expect(await c.hasSession("s1")).toBe(true);
    expect(await c.hasSession("s2")).toBe(false);
    await c.run(spec({ session: { id: "s1", resume: true } }));
    expect(a.specs[0]!.session).toEqual({ id: "s1", resume: false });
    expect(b.specs[0]!.session).toEqual({ id: "s1", resume: true });
    await c.removeSession("s1");
    expect([a.removed, b.removed]).toEqual([["s1"], ["s1"]]);
  });

  it("keeps no state between runs: each run starts at the first member", async () => {
    const a = new ScriptedRunner(res("rate_limited"));
    const b = new ScriptedRunner(res("completed"));
    const c = chain(a, b);
    await c.run(spec());
    await c.run(spec());
    expect([a.specs.length, b.specs.length]).toEqual([2, 2]);
  });
});

class ScriptedLLM implements LLMProvider {
  calls = 0;
  constructor(private readonly answer: LLMResponse | Error) {}
  async complete(_req: LLMRequest) {
    this.calls++;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}
const answer = (stop_reason: LLMResponse["stop_reason"], output_tokens = 4, text = "hi"): LLMResponse => ({
  text, stop_reason, usage: { input_tokens: 3, output_tokens, cost_usd: 0.001 },
});
const llmChain = (...ps: ScriptedLLM[]) => new FallbackLLM(ps.map((impl, i) => ({ name: ["claude-cli", "openai-compatible"][i]!, impl })));
const req: LLMRequest = { model_class: "cheap", messages: [{ role: "user", content: "x" }], max_tokens: 10, data_env: "test" };

describe("FallbackLLM", () => {
  it("a thrown error falls over; the answer names who served it and sums usage", async () => {
    const b = new ScriptedLLM(answer("end"));
    const r = await llmChain(new ScriptedLLM(new Error("claude: not logged in")), b).complete(req);
    expect(b.calls).toBe(1);
    expect(r.served_by).toBe("openai-compatible");
    expect(r.usage).toEqual({ input_tokens: 3, output_tokens: 4, cost_usd: 0.001 });
  });

  it("an error stop with no output falls over, and its usage is counted", async () => {
    const r = await llmChain(new ScriptedLLM(answer("error", 0, "")), new ScriptedLLM(answer("end"))).complete(req);
    expect(r.served_by).toBe("openai-compatible");
    expect(r.usage.input_tokens).toBe(6);
    expect(r.usage.cost_usd).toBeCloseTo(0.002);
  });

  for (const stop of ["end", "refused", "max_tokens"] as const) {
    it(`a ${stop} answer is the answer; the next provider is not called`, async () => {
      const b = new ScriptedLLM(answer("end"));
      const r = await llmChain(new ScriptedLLM(answer(stop)), b).complete(req);
      expect(b.calls).toBe(0);
      expect(r.stop_reason).toBe(stop);
      expect(r.served_by).toBe("claude-cli");
    });
  }

  it("every provider throwing: the chain throws, naming each failure in order", async () => {
    const c = llmChain(new ScriptedLLM(new Error("first down")), new ScriptedLLM(new Error("second down")));
    await expect(c.complete(req)).rejects.toThrow("every LLM provider failed: claude-cli: first down; openai-compatible: second down");
  });

  it("the last provider answering an error stop: that answer, with the failures as its text", async () => {
    const r = await llmChain(new ScriptedLLM(new Error("first down")), new ScriptedLLM(answer("error", 0, ""))).complete(req);
    expect(r.stop_reason).toBe("error");
    expect(r.text).toBe("every LLM provider failed: claude-cli: first down; openai-compatible: error stop");
  });
});

describe("selection: plugins.runner and plugins.llm take a list", () => {
  const select = (plugins: Record<string, unknown>) =>
    selectPlugins(REGISTRY, { store: { type: "sqlite" }, auth: "github", plugins: { ...(REAL.plugins as object), ...plugins } }, { platform: "linux" });
  const failure = (plugins: Record<string, unknown>): string | null => {
    try {
      select(plugins);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("a list of one is exactly the single name", () => {
    expect(select({ runner: ["claude-code"], llm: ["claude-cli"] })).toEqual(select({ runner: "claude-code", llm: "claude-cli" }));
    const s = select({ runner: "claude-code" });
    expect(s.runners).toBeUndefined();
    expect(selectedRunners(s)).toEqual(["claude-code"]);
  });

  it("a longer list keeps the first name and the whole chain, in order", () => {
    const s = select({ runner: ["claude-code", "openai-compatible"], llm: ["claude-cli", "openai-compatible"] });
    expect(s.runner).toBe("claude-code");
    expect(selectedRunners(s)).toEqual(["claude-code", "openai-compatible"]);
    expect(s.llm).toBe("claude-cli");
    expect(selectedLlms(s)).toEqual(["claude-cli", "openai-compatible"]);
  });

  for (const key of ["runner", "llm"] as const) {
    it(`plugins.${key}: an empty list, an unknown name or a repeat fails, naming the key`, () => {
      const known = key === "runner" ? "claude-code" : "claude-cli";
      expect(failure({ [key]: [] })).toMatch(new RegExp(`plugins\\.${key} is an empty list`));
      const unknown = failure({ [key]: [known, "no-such-plugin"] });
      expect(unknown).toMatch(new RegExp(`plugins\\.${key}`));
      expect(unknown).toContain("no-such-plugin");
      expect(failure({ [key]: [known, known] })).toMatch(new RegExp(`plugins\\.${key} lists "${known}" twice`));
    });
  }

  it("declares the secrets of every chain member, and only of selected ones", () => {
    const single = declaredSecretNames(REGISTRY, select({ runner: "claude-code", llm: "claude-cli" }));
    expect(single.has("OPENAI_COMPATIBLE_API_KEY" as never)).toBe(false);
    const runnerChain = declaredSecretNames(REGISTRY, select({ runner: ["claude-code", "openai-compatible"], llm: "claude-cli" }));
    expect(runnerChain.has("OPENAI_COMPATIBLE_API_KEY" as never)).toBe(true);
    expect(runnerChain.has("CLAUDE_CODE_OAUTH_TOKEN" as never)).toBe(true);
    const llmChain = declaredSecretNames(REGISTRY, select({ runner: "claude-code", llm: ["claude-cli", "openai-compatible"] }));
    expect(llmChain.has("OPENAI_COMPATIBLE_API_KEY" as never)).toBe(true);
  });
});

describe("worker: one log line per fall-over", () => {
  const TOKEN = `ghp_${"Ab3".repeat(12)}`;
  it("logs runner fallback with from, to and reason; a reason the scan flags is withheld", async () => {
    const f = await pipeline({
      implement: () => ({
        output: { summary: "s", next_steps: "n" },
        transcript: "t",
        served_by: "openai-compatible",
        fallbacks: [
          { from: "claude-code", to: "openai-compatible", reason: "rate_limited: usage limit" },
          { from: "x", to: "y", reason: `failed: ${TOKEN}` },
        ],
      }),
    });
    const item = await f.submit();
    await f.step();
    const [impl] = await f.runs(item, "implement");
    expect(impl!.status).toBe("succeeded");
    const lines = f.log.lines.filter((l) => l.msg === "runner fallback");
    expect(lines.map((l) => l.fields)).toEqual([
      expect.objectContaining({ run_id: impl!.id, from: "claude-code", to: "openai-compatible", reason: "rate_limited: usage limit" }),
      expect.objectContaining({ from: "x", to: "y", reason: "[withheld]" }),
    ]);
    expect(JSON.stringify(f.log.lines)).not.toContain(TOKEN);
  });
});
