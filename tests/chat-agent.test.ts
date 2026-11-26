// Chat, phase 1 (docs/plugins/llm-provider.md): chat messages in controller_chat_messages, keyed by session and seq,
// and the provider call with tools. A test drives two calls by hand: the reply's tool call is answered with a `tool`
// message in the next call's messages. No live model call: a fake provider, a stubbed fetch, a CLI that never runs.

import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ClaudeCliLLMProvider } from "../src/impl/llm/claude-cli-llm-provider.js";
import { OpenAICompatibleLLMProvider } from "../src/impl/llm/openai-compatible-llm-provider.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewChatMessage } from "../src/interfaces/factory-store.js";
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse, LLMTool } from "../src/interfaces/llm-provider.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";

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
