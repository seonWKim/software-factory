// Chat, phase 1 (docs/plugins/llm-provider.md): chat messages in controller_chat_messages, keyed by session and seq,
// and the provider call with tools. A test drives two calls by hand: the reply's tool call is answered with a `tool`
// message in the next call's messages. Phase 2 (design 04-chat-agent): the turn loop, chatTurn, with the chat's
// read-only tools, the egress scan and a spend row per turn. No live model call: a fake provider, a stubbed fetch, a
// CLI that never runs.

import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFeatureMap } from "../src/api/feature-map.js";
import { buildRegistry, declare } from "../src/api/registry.js";
import { object, string } from "../src/api/schema.js";
import { type ChatDeps, chatTurn } from "../src/core/chat-agent.js";
import { type ChatTool, ChatToolBroker, featureMapTools } from "../src/core/chat-agent-tools.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ClaudeCliLLMProvider } from "../src/impl/llm/claude-cli-llm-provider.js";
import { OpenAICompatibleLLMProvider } from "../src/impl/llm/openai-compatible-llm-provider.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewChatMessage } from "../src/interfaces/factory-store.js";
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse, LLMTool } from "../src/interfaces/llm-provider.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const USAGE = { input_tokens: 1, output_tokens: 1, cost_usd: null };
const TOOL: LLMTool = {
  name: "list_features",
  description: "Lists the feature map's features.",
  parameters: { type: "object", properties: { area: { type: "string" } }, required: ["area"], additionalProperties: false },
};
const REQ: LLMRequest = { model_class: "cheap", messages: [{ role: "user", content: "What features are there?" }], max_tokens: 64, data_env: "test", tools: [TOOL] };

function dbFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sf-chat-")), "factory.db");
}

async function open(file: string): Promise<SqlFactoryStore> {
  const store = new SqlFactoryStore(new SqliteDriver(file), new FakeClock());
  await store.migrate();
  return store;
}

const TURN: NewChatMessage[] = [
  { seq: 0, role: "user", content: "What features are there?" },
  { seq: 1, role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "list_features", arguments: '{"area":"store"}' }] },
  { seq: 2, role: "tool", content: '["chat"]', tool_call_id: "call_1" },
  { seq: 3, role: "assistant", content: "There is one: chat." },
];

describe("chat messages in the store", () => {
  it("stores role, content, tool calls and tool call id per (session, seq), and lists them in seq order after a reopen", async () => {
    const file = dbFile();
    const store = await open(file);
    // Appended out of order and in two batches: the list orders by seq.
    expect(await store.appendChatMessages("s1", [TURN[2]!, TURN[0]!])).toBe(true);
    expect(await store.appendChatMessages("s1", [TURN[3]!, TURN[1]!])).toBe(true);
    expect(await store.appendChatMessages("s2", [{ seq: 0, role: "user", content: "another session" }])).toBe(true);
    await store.close();

    const again = await open(file);
    try {
      const listed = await again.listChatMessages("s1");
      expect(listed.map(({ created_at: _at, ...m }) => m)).toEqual(TURN.map((m) => ({ session_id: "s1", ...m })));
      expect(listed[0]).not.toHaveProperty("tool_calls");
      expect(listed[0]).not.toHaveProperty("tool_call_id");
      expect((await again.listChatMessages("s2")).map((m) => m.content)).toEqual(["another session"]);
      expect(await again.listChatMessages("none")).toEqual([]);
      const tables = (await again.listTables()).map((t) => t.name);
      expect(tables).toContain("controller_chat_messages");
    } finally {
      await again.close();
    }
  });

  it("refuses a batch holding a seq the session already has and writes none of it", async () => {
    const store = await open(dbFile());
    try {
      expect(await store.appendChatMessages("s1", [TURN[0]!, TURN[1]!])).toBe(true);
      const before = await store.listChatMessages("s1");
      expect(await store.appendChatMessages("s1", [TURN[2]!, { seq: 1, role: "assistant", content: "a second seq 1" }])).toBe(false);
      expect(await store.appendChatMessages("s1", [TURN[2]!, TURN[2]!])).toBe(false);
      expect(await store.listChatMessages("s1")).toEqual(before);
      // The same seq in another session is no clash.
      expect(await store.appendChatMessages("s2", [TURN[0]!, TURN[1]!])).toBe(true);
    } finally {
      await store.close();
    }
  });
});

describe("a turn with tools, driven by hand", () => {
  it("a tool call the provider returns is answered by a tool message in the next call's messages", async () => {
    const seen: LLMRequest[] = [];
    const fake: LLMProvider = {
      async complete(req: LLMRequest): Promise<LLMResponse> {
        seen.push(req);
        if (seen.length === 1) return { text: "", tool_calls: [{ id: "call_1", name: "list_features", arguments: '{"area":"store"}' }], stop_reason: "end", usage: USAGE };
        return { text: "There is one: chat.", stop_reason: "end", usage: USAGE };
      },
    };

    const first = await fake.complete(REQ);
    const call = first.tool_calls![0]!;
    const result: LLMMessage = { role: "tool", content: '["chat"]', tool_call_id: call.id };
    const second = await fake.complete({ ...REQ, messages: [...REQ.messages, { role: "assistant", content: first.text, tool_calls: first.tool_calls! }, result] });

    expect(seen[0]!.tools).toEqual([TOOL]);
    expect(seen[1]!.messages).toContainEqual(result);
    expect(seen[1]!.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: [call] }));
    expect(second.text).toBe("There is one: chat.");
    expect(second.tool_calls ?? []).toEqual([]);
  });
});

class OneSecret implements SecretStore {
  constructor(private readonly value: string) {}
  async get(name: SecretName): Promise<Secret | null> {
    return { name, reveal: () => this.value, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return [this.value];
  }
}

describe("openai-compatible provider with tools", () => {
  it("sends the tools and the tool messages, and returns the reply's tool calls (fetch stubbed)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const message = { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "list_features", arguments: '{"area":"ui"}' } }] };
      return new Response(JSON.stringify({ model: "m", choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
    });
    const p = new OpenAICompatibleLLMProvider({
      secrets: new OneSecret("sk-test-0123456789"),
      config: { base_url: "https://llm.example.test/v1", models: { cheap: "c", standard: "s", strong: "x" } },
    });

    const r = await p.complete({
      ...REQ,
      messages: [
        ...REQ.messages,
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "list_features", arguments: '{"area":"store"}' }] },
        { role: "tool", content: '["chat"]', tool_call_id: "call_1" },
      ],
    });

    expect(r).toMatchObject({ stop_reason: "end", tool_calls: [{ id: "call_9", name: "list_features", arguments: '{"area":"ui"}' }] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.tools).toEqual([{ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters } }]);
    const messages = bodies[0]!.messages as Record<string, unknown>[];
    expect(messages).toContainEqual({ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_features", arguments: '{"area":"store"}' } }] });
    expect(messages).toContainEqual({ role: "tool", content: '["chat"]', tool_call_id: "call_1" });
  });

  it("sends no tools field for a request without tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: "hi" } }], usage: {} }), { status: 200 });
    });
    const p = new OpenAICompatibleLLMProvider({
      secrets: new OneSecret("sk-test-0123456789"),
      config: { base_url: "https://llm.example.test/v1", models: { cheap: "c", standard: "s", strong: "x" } },
    });
    const { tools: _tools, ...plain } = REQ;
    const r = await p.complete(plain);
    expect(r.text).toBe("hi");
    expect(r).not.toHaveProperty("tool_calls");
    expect(bodies[0]).not.toHaveProperty("tools");
  });
});

describe("claude-cli provider with tools", () => {
  it("answers stop_reason error and never runs the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-chat-cli-"));
    const marker = join(dir, "ran");
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\necho '{"result":"ran"}'\n`);
    chmodSync(bin, 0o755);
    const p = new ClaudeCliLLMProvider({
      secrets: new OneSecret("unused"),
      claudeConfigDir: join(dir, "config"),
      workDir: join(dir, "work"),
      models: { cheap: "c", standard: "s", strong: "x" },
      claudeBin: bin,
    });

    const r = await p.complete(REQ);
    expect(r.stop_reason).toBe("error");
    expect(r.usage.output_tokens).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, "work"))).toBe(false);
  });
});

// ---- Phase 2: the turn loop ----

const SECRET = `ghp_${"Ab3".repeat(12)}`;
const REGISTRY = buildRegistry([declare({
  id: "store.ping", area: "store", description: "Answers that the store is up.", permission: "read", method: "GET", path: "/api/v1/store/ping",
  input: object({}), output: object({ up: string() }), run: () => ({ up: "yes" }),
})]);
const mapTools = () => featureMapTools((p) => readFeatureMap(REGISTRY, p));

type Step = Omit<LLMResponse, "usage" | "stop_reason"> & Partial<Pick<LLMResponse, "usage" | "stop_reason">>;
/** A provider that answers `steps` in order and keeps each request. */
function scripted(steps: Step[]): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  return {
    seen,
    async complete(req) {
      seen.push(req);
      const s = steps[seen.length - 1] ?? { text: "out of script" };
      return { stop_reason: "end", usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, ...s };
    },
  };
}
const call = (name: string, args: unknown, id = `c_${name}`) => ({ id, name, arguments: JSON.stringify(args) });

async function turnDeps(llm: LLMProvider, broker: ToolBroker = new ChatToolBroker(mapTools())): Promise<{ d: ChatDeps; store: SqlFactoryStore }> {
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const store = new SqlFactoryStore(new SqliteDriver(dbFile()), clock);
  await store.migrate();
  let n = 0;
  return { store, d: { store, llm, broker, clock, scanner: new PatternEgressScanner(async () => []), newTurnId: () => `ct_${n++}` } };
}

describe("chatTurn", () => {
  it("offers the feature-map tools, runs the asked call, stores the turn and one spend row, and returns the reply", async () => {
    const llm = scripted([{ text: "", tool_calls: [call("list_areas", {})] }, { text: "One area: store." }]);
    const { d, store } = await turnDeps(llm);
    try {
      expect(await chatTurn(d, "s1", "What areas are there?")).toEqual({ ok: true, reply: "One area: store." });
      expect(llm.seen[0]!.tools!.map((t) => t.name)).toEqual(["list_areas", "list_features", "get_feature", "get_feature_schema"]);
      const tool = { role: "tool", content: JSON.stringify({ areas: [{ id: "store", capabilities: ["store.ping"] }] }), tool_call_id: "c_list_areas" };
      expect(llm.seen[1]!.messages).toContainEqual(tool);
      const stored = (await store.listChatMessages("s1")).map((m) => [m.seq, m.role, m.content]);
      expect(stored).toEqual([[0, "user", "What areas are there?"], [1, "assistant", ""], [2, "tool", tool.content], [3, "assistant", "One area: store."]]);
      expect(await store.listChatSpendBetween("2026-11-26", "2026-11-26")).toEqual([{ turn_id: "ct_0", session_id: "s1", day: "2026-11-26", cost_usd: 0.02, tokens: 30 }]);

      // The next turn sends the stored history and takes the next seqs.
      const again = scripted([{ text: "Still one." }]);
      expect(await chatTurn({ ...d, llm: again }, "s1", "And now?")).toEqual({ ok: true, reply: "Still one." });
      expect(again.seen[0]!.messages.map((m) => m.content)).toEqual(["What areas are there?", "", tool.content, "One area: store.", "And now?"]);
      expect((await store.listChatMessages("s1")).map((m) => m.seq)).toContain(5);
      expect((await store.listChatSpendBetween("2026-11-26", "2026-11-26")).map((s) => s.turn_id)).toEqual(["ct_0", "ct_1"]);
    } finally {
      await store.close();
    }
  });

  it("a read-only tool added to the broker is offered and callable, with no chat code changed", async () => {
    const count: ChatTool = { name: "store.count", read_only: true, description: "Counts items.", input_schema: { type: "object" }, call: async () => ({ ok: true, content: { count: 7 } }) };
    const llm = scripted([{ text: "", tool_calls: [call("store.count", {})] }, { text: "Seven." }]);
    const { d, store } = await turnDeps(llm, new ChatToolBroker([...mapTools(), count]));
    try {
      expect(await chatTurn(d, "s1", "How many?")).toEqual({ ok: true, reply: "Seven." });
      expect(llm.seen[0]!.tools!.map((t) => t.name)).toContain("store.count");
      expect(llm.seen[1]!.messages).toContainEqual({ role: "tool", content: '{"count":7}', tool_call_id: "c_store.count" });
    } finally {
      await store.close();
    }
  });

  it("offers no write tool and refuses a call to one, or to an unknown name, without reaching the broker", async () => {
    const calls: string[] = [];
    const tools: ToolDescriptor[] = [
      { name: "repo.read", read_only: true, description: "Reads.", input_schema: { type: "object" } },
      { name: "git.store_branch", read_only: false, description: "Writes.", input_schema: { type: "object" } },
    ];
    const broker: ToolBroker = {
      listTools: (g) => tools.filter((t) => g.includes(t.name)),
      allTools: () => tools,
      async call(_ctx: ToolCallContext, name: string): Promise<ToolResult> {
        calls.push(name);
        return { ok: true, content: "done" };
      },
    };
    const llm = scripted([{ text: "", tool_calls: [call("git.store_branch", { branch: "main" }), call("no.such_tool", {}), call("repo.read", {})] }, { text: "I cannot write." }]);
    const { d, store } = await turnDeps(llm, broker);
    try {
      expect(await chatTurn(d, "s1", "Push it.")).toEqual({ ok: true, reply: "I cannot write." });
      expect(llm.seen[0]!.tools!.map((t) => t.name)).toEqual(["repo.read"]);
      expect(calls).toEqual(["repo.read"]);
      const refused = llm.seen[1]!.messages.find((m) => m.tool_call_id === "c_git.store_branch")!;
      expect(refused.content).toMatch(/not a read-only tool/);
      expect(llm.seen[1]!.messages.find((m) => m.tool_call_id === "c_no.such_tool")!.content).toMatch(/not a read-only tool/);
    } finally {
      await store.close();
    }
  });

  it("a secret in a tool result stores no message and returns nothing; the model never sees it", async () => {
    const leak: ChatTool = { name: "store.leak", read_only: true, description: "Leaks.", input_schema: { type: "object" }, call: async () => ({ ok: true, content: SECRET }) };
    const llm = scripted([{ text: "", tool_calls: [call("store.leak", {})] }, { text: "never" }]);
    const { d, store } = await turnDeps(llm, new ChatToolBroker([leak]));
    try {
      expect(await chatTurn(d, "s1", "Leak it.")).toEqual({ ok: false, reason: "withheld" });
      expect(llm.seen).toHaveLength(1);
      expect(await store.listChatMessages("s1")).toEqual([]);
      // The model calls were spent: the turn's spend is still counted.
      expect((await store.listChatSpendBetween("2026-11-26", "2026-11-26")).map((s) => s.session_id)).toEqual(["s1"]);
    } finally {
      await store.close();
    }
  });

  it("a secret in the reply or in the owner's message stores no message and returns nothing", async () => {
    const { d, store } = await turnDeps(scripted([{ text: `Here: ${SECRET}` }]));
    try {
      expect(await chatTurn(d, "s1", "Tell me.")).toEqual({ ok: false, reason: "withheld" });
      const silent = scripted([]);
      expect(await chatTurn({ ...d, llm: silent }, "s2", `my key ${SECRET}`)).toEqual({ ok: false, reason: "withheld" });
      expect(silent.seen).toEqual([]);
      expect(await store.listChatMessages("s1")).toEqual([]);
      expect(await store.listChatMessages("s2")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("stores nothing on a provider error or when the model keeps asking for tools; an unknown cost is stored as null", async () => {
    const { d, store } = await turnDeps(scripted([{ text: "", stop_reason: "error", usage: { input_tokens: 1, output_tokens: 0, cost_usd: null } }]));
    try {
      expect(await chatTurn(d, "s1", "Hi")).toEqual({ ok: false, reason: "model_error" });
      const loop = scripted(Array.from({ length: 20 }, () => ({ text: "", tool_calls: [call("list_areas", {})] })));
      expect(await chatTurn({ ...d, llm: loop }, "s2", "Hi")).toEqual({ ok: false, reason: "too_many_steps" });
      expect(await store.listChatMessages("s1")).toEqual([]);
      expect(await store.listChatMessages("s2")).toEqual([]);
      const spend = await store.listChatSpendBetween("2026-11-26", "2026-11-26");
      expect(spend.find((s) => s.session_id === "s1")).toMatchObject({ cost_usd: null, tokens: 1 });
    } finally {
      await store.close();
    }
  });

  it("a failed turn takes no seq, and the next turn's spend is still counted", async () => {
    const llm = scripted([{ text: "", stop_reason: "error", usage: { input_tokens: 1, output_tokens: 0, cost_usd: null } }, { text: "Hello." }]);
    const { d, store } = await turnDeps(llm);
    try {
      expect(await chatTurn(d, "s1", "Hi")).toEqual({ ok: false, reason: "model_error" });
      expect(await chatTurn(d, "s1", "Hi again")).toEqual({ ok: true, reply: "Hello." });
      expect((await store.listChatMessages("s1")).map((m) => m.seq)).toEqual([0, 1]);
      const spend = await store.listChatSpendBetween("2026-11-26", "2026-11-26");
      expect(spend.map((s) => [s.turn_id, s.session_id])).toEqual([["ct_0", "s1"], ["ct_1", "s1"]]);
    } finally {
      await store.close();
    }
  });

  it("a spend row already stored for the turn is not stored twice", async () => {
    const { store } = await turnDeps(scripted([]));
    try {
      const row = { turn_id: "ct_9", session_id: "s1", day: "2026-11-26", cost_usd: 0.5, tokens: 9 };
      expect(await store.recordChatSpend(row)).toBe(true);
      expect(await store.recordChatSpend({ ...row, cost_usd: 1 })).toBe(false);
      expect(await store.listChatSpendBetween("2026-11-26", "2026-11-26")).toEqual([row]);
      expect(await store.listChatSpendBetween("2026-11-27", "2026-11-28")).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
