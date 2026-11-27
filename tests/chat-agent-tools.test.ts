// The chat's tools (design 04-chat-agent): the four feature-map read tools over the feature map
// (src/api/feature-map.ts) of a fixture registry, and the chat's broker, which serves read-only tools only.

import { describe, expect, it } from "vitest";
import { readFeatureMap } from "../src/api/feature-map.js";
import { buildRegistry, callCapability, declare, refuse } from "../src/api/registry.js";
import { array, integer, jsonObject, object, optional, string } from "../src/api/schema.js";
import {
  CALL_FEATURE_MAX_CHARS, CALL_FEATURE_ROWS, type ChatTool, ChatToolBroker, type FeatureCaller, callFeatureTool, chatCallContext, chatToolsOf, featureMapTools,
} from "../src/core/chat-agent-tools.js";
import { type ChatDeps, CHAT_SYSTEM, chatTools, chatTurn } from "../src/core/chat-agent.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { ServerDeps } from "../src/ui/server.js";
import { Withholder } from "../src/ui/withhold.js";

const PING = declare({
  id: "store.ping", area: "store", description: "Answers that the store is up.", permission: "read", method: "GET", path: "/api/v1/store/ping",
  input: object({ times: integer() }), output: object({ up: string() }), run: () => ({ up: "yes" }),
});
const ADD = declare({
  id: "tasks.add", area: "tasks", description: "Adds a task.", permission: "owner", method: "POST", path: "/api/v1/tasks/add",
  input: object({ title: string() }), output: object({ id: string() }), run: () => ({ id: "t1" }),
});
const REGISTRY = buildRegistry([PING, ADD]);
const read = (path: string) => readFeatureMap(REGISTRY, path);
const broker = () => new ChatToolBroker(featureMapTools(read));
const CTX = chatCallContext("s1");
const byName = (name: string) => featureMapTools(read).find((t) => t.name === name)!;

describe("the feature-map read tools", () => {
  it("are the chat's tools today, all read-only, in this order", () => {
    const tools = chatTools(broker());
    expect(tools.map((t) => t.name)).toEqual(["list_areas", "list_features", "get_feature", "get_feature_schema"]);
    expect(tools.every((t) => t.read_only)).toBe(true);
    for (const t of tools) expect(t.input_schema).toMatchObject({ type: "object" });
  });

  it("list_areas gives every area with its feature ids", async () => {
    expect(await broker().call(CTX, "list_areas", {})).toEqual({ ok: true, content: { areas: [{ id: "store", capabilities: ["store.ping"] }, { id: "tasks", capabilities: ["tasks.add"] }] } });
  });

  it("list_features gives one area's features, and none for an area with none", async () => {
    const r = await broker().call(CTX, "list_features", { area: "tasks" });
    expect(r).toEqual({ ok: true, content: { area: "tasks", features: [{ id: "tasks.add", area: "tasks", description: "Adds a task.", permission: "owner", method: "POST", path: "/api/v1/tasks/add" }] } });
    expect(await broker().call(CTX, "list_features", { area: "nowhere" })).toEqual({ ok: true, content: { area: "nowhere", features: [] } });
    expect(await broker().call(CTX, "list_features", {})).toMatchObject({ ok: false, error_code: "bad_args" });
  });

  it("get_feature gives one feature's summary; an unknown id is not found", async () => {
    expect(await byName("get_feature").call({ id: "store.ping" })).toEqual({
      ok: true, content: { feature: { id: "store.ping", area: "store", description: "Answers that the store is up.", permission: "read", method: "GET", path: "/api/v1/store/ping" } },
    });
    expect(await byName("get_feature").call({ id: "store.nope" })).toMatchObject({ ok: false, error_code: "not_found" });
    expect(await byName("get_feature").call({ id: 3 })).toMatchObject({ ok: false, error_code: "bad_args" });
  });

  it("get_feature_schema gives the input and output JSON Schemas of the declaration", async () => {
    const r = await byName("get_feature_schema").call({ id: "tasks.add" });
    expect(r).toEqual({ ok: true, content: { id: "tasks.add", input: ADD.input.json(), output: ADD.output.json() } });
    expect(await byName("get_feature_schema").call({ id: "no/such" })).toMatchObject({ ok: false, error_code: "not_found" });
  });
});

describe("the chat's broker", () => {
  const extra: ChatTool = { name: "store.count", read_only: true, description: "Counts.", input_schema: { type: "object" }, call: async () => ({ ok: true, content: 3 }) };

  it("refuses a tool that is not read-only, and a name given twice", () => {
    const write = { ...extra, read_only: false } as unknown as ChatTool;
    expect(() => new ChatToolBroker([write])).toThrow(/only read-only/);
    expect(() => new ChatToolBroker([extra, extra])).toThrow(/twice/);
  });

  it("lists the granted tools, answers unknown_tool for a name it does not serve, and hides a thrown error's text", async () => {
    const throws: ChatTool = { ...extra, name: "store.boom", call: async () => { throw new Error("secret detail"); } };
    const b = new ChatToolBroker([...featureMapTools(read), extra, throws]);
    expect(b.listTools(["store.count"]).map((t) => t.name)).toEqual(["store.count"]);
    expect(b.allTools().map((t) => t.name)).toContain("store.count");
    expect(b.allTools()[0]).not.toHaveProperty("call");
    expect(await b.call(CTX, "git.store_branch", {})).toMatchObject({ ok: false, error_code: "unknown_tool" });
    expect(await b.call(CTX, "store.boom", {})).toEqual({ ok: false, error_code: "tool_error", message: "store.boom failed" });
  });
});

describe("call_feature", () => {
  // A fixture registry: a GET list that records its runs, a GET that refuses, and a POST that must never run.
  const runs: string[] = [];
  const ITEMS = declare({
    id: "items.list", area: "items", description: "Lists items.", permission: "read", method: "GET", path: "/api/v1/items",
    input: object({ blocked_on: optional(string()) }), output: object({ total: integer(), items: array(jsonObject()), as_of: string() }),
    run: (_c, i) => {
      runs.push(`items.list:${i.blocked_on ?? ""}`);
      const items = Array.from({ length: 57 }, (_, n) => ({ id: `wi_${n}`, title: `Item ${n}`, blocked_on: "human" }));
      return { total: items.length, items, as_of: "2026-11-28T00:00:00.000Z" };
    },
  });
  const SHUT = declare({
    id: "store.shut", area: "store", description: "Refuses.", permission: "owner", method: "GET", path: "/api/v1/store/shut",
    input: object({}), output: object({ up: string() }), run: () => (runs.push("store.shut"), refuse(503, "The store is shut.")),
  });
  const WRITE = declare({
    id: "tasks.add", area: "tasks", description: "Adds a task.", permission: "owner", method: "POST", path: "/api/v1/tasks/add",
    input: object({ title: string() }), output: object({ id: string() }), run: () => (runs.push("tasks.add"), { id: "t1" }),
  });
  const BIG = declare({
    id: "store.big", area: "store", description: "One huge text.", permission: "read", method: "GET", path: "/api/v1/store/big",
    input: object({}), output: object({ text: string() }), run: () => ({ text: "x".repeat(CALL_FEATURE_MAX_CHARS + 1) }),
  });
  const LIVE = buildRegistry([ITEMS, SHUT, WRITE, BIG]);
  const scanner = new PatternEgressScanner(async () => []);
  const d = { clock: new FakeClock("2026-11-28T00:00:00.000Z") } as unknown as ServerDeps;
  const caller: FeatureCaller = (id, input) => callCapability(LIVE, d, id, input, new Withholder(scanner));
  const tool = () => callFeatureTool(caller);
  const fresh = () => runs.splice(0);

  it("is offered with the four feature-map tools, read-only, with input id (string) and input (object)", () => {
    const tools = chatTools(new ChatToolBroker(chatToolsOf(read, caller)));
    expect(tools.map((t) => t.name)).toEqual(["list_areas", "list_features", "get_feature", "get_feature_schema", "call_feature"]);
    const t = tools.find((x) => x.name === "call_feature")!;
    expect(t.read_only).toBe(true);
    expect(t.input_schema).toMatchObject({ type: "object", properties: { id: { type: "string" }, input: { type: "object" } }, required: ["id"] });
  });

  it("runs a GET capability with its input and answers its data", async () => {
    fresh();
    const r = await tool().call({ id: "items.list", input: { blocked_on: "human" } });
    expect(r.ok).toBe(true);
    expect(fresh()).toEqual(["items.list:human"]);
    expect(r.ok && r.content).toMatchObject({ id: "items.list", result: { total: 57, as_of: "2026-11-28T00:00:00.000Z" } });
  });

  it("refuses a POST capability and an unknown id, and never runs either", async () => {
    fresh();
    expect(await tool().call({ id: "tasks.add", input: { title: "x" } })).toMatchObject({ ok: false, error_code: "not_get" });
    expect(await tool().call({ id: "tasks.nope", input: {} })).toMatchObject({ ok: false, error_code: "not_found", message: "No feature tasks.nope." });
    expect(fresh()).toEqual([]);
  });

  it("checks input against the capability's own schema, and a bad input runs nothing", async () => {
    fresh();
    const r = await tool().call({ id: "items.list", input: { blocked_on: 7 } });
    expect(r).toMatchObject({ ok: false, error_code: "bad_input" });
    expect(r.ok ? "" : r.message).toMatch(/blocked_on/);
    expect(await tool().call({ id: "items.list", input: "human" })).toMatchObject({ ok: false, error_code: "bad_args" });
    expect(await tool().call({ input: {} })).toMatchObject({ ok: false, error_code: "bad_args" });
    expect(fresh()).toEqual([]);
  });

  it("answers a capability's refusal as ok false with its error text", async () => {
    fresh();
    expect(await tool().call({ id: "store.shut" })).toEqual({ ok: false, error_code: "refused", message: "The store is shut." });
    expect(fresh()).toEqual(["store.shut"]);
  });

  it("keeps the first rows of each top-level list and names each cut field with its shown and total counts", async () => {
    const r = await tool().call({ id: "items.list", input: {} });
    const content = (r.ok ? r.content : null) as { result: { items: { id: string }[]; total: number }; trimmed: unknown };
    expect(content.result.items.map((i) => i.id)).toEqual(Array.from({ length: CALL_FEATURE_ROWS }, (_, n) => `wi_${n}`));
    expect(content.trimmed).toEqual([{ field: "items", shown: CALL_FEATURE_ROWS, total: 57 }]);
    // A list within the cap is whole, and no trimmed is answered.
    const short = await callFeatureTool(async () => ({ status: 200, value: { items: [{ id: "a" }] } })).call({ id: "items.list" });
    expect(short).toEqual({ ok: true, content: { id: "items.list", result: { items: [{ id: "a" }] } } });
  });

  it("answers too_large for a result still over the cap once trimmed, never a part of it", async () => {
    const r = await tool().call({ id: "store.big" });
    expect(r).toMatchObject({ ok: false, error_code: "too_large" });
    expect(r.ok ? "" : r.message).toMatch(/^too_large/);
    expect(JSON.stringify(r)).not.toContain("xxxxxxxxxx");
  });

  it("the system prompt sends live-data questions to call_feature and asks it to say when a list was trimmed", () => {
    expect(CHAT_SYSTEM).toContain("call_feature");
    expect(CHAT_SYSTEM).toMatch(/items\.list[^.]*blocked_on[^.]*human/);
    expect(CHAT_SYSTEM).toMatch(/activity\.actors[^.]*alerts[^.]*running/);
    expect(CHAT_SYSTEM).toMatch(/trimmed/);
  });

  describe("in a chat turn", () => {
    const SECRET = `ghp_${"Ab3".repeat(12)}`;
    function scripted(steps: Partial<LLMResponse>[]): LLMProvider & { seen: LLMRequest[] } {
      const seen: LLMRequest[] = [];
      return { seen, async complete(req) { seen.push(req); return { text: "", stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, ...(steps[seen.length - 1] ?? { text: "end" }) }; } };
    }
    const memory = (): ChatDeps["store"] => ({ listChatMessages: async () => [], appendChatMessages: async () => true, recordChatSpend: async () => true });
    const turn = (llm: LLMProvider, c: FeatureCaller) =>
      chatTurn({ store: memory(), llm, broker: new ChatToolBroker(chatToolsOf(read, c)), scanner, clock: new FakeClock(), newTurnId: () => "ct_1" }, "s1", "What needs me today?");
    const ask = { tool_calls: [{ id: "c1", name: "call_feature", arguments: JSON.stringify({ id: "items.list", input: { blocked_on: "human" } }) }] };

    it("a secret-like value in a result withholds the turn, and is in no message the provider receives", async () => {
      const llm = scripted([ask, { text: "never" }]);
      const leaky: FeatureCaller = async () => ({ status: 200, value: { items: [{ id: "wi_1", title: `token ${SECRET}` }] } });
      expect(await turn(llm, leaky)).toEqual({ ok: false, reason: "withheld" });
      expect(llm.seen).toHaveLength(1);
      expect(JSON.stringify(llm.seen)).not.toContain(SECRET);
    });

    it("through the registry, a secret in a capability's answer never reaches the provider", async () => {
      const LEAK = declare({
        id: "items.list", area: "items", description: "Leaks.", permission: "read", method: "GET", path: "/api/v1/items",
        input: object({}), output: object({ items: array(object({ id: string(), title: string() })) }), run: () => ({ items: [{ id: "wi_1", title: `token ${SECRET}` }] }),
      });
      const llm = scripted([ask, { text: "Done." }]);
      const viaRegistry: FeatureCaller = (id, input) => callCapability(buildRegistry([LEAK]), d, id, input, new Withholder(scanner));
      await turn(llm, (id) => viaRegistry(id, {}));
      expect(JSON.stringify(llm.seen)).not.toContain(SECRET);
    });
  });
});
