// The chat's tools (design 04-chat-agent): the four feature-map read tools over the feature map
// (src/api/feature-map.ts) of a fixture registry, and the chat's broker, which serves read-only tools only.

import { describe, expect, it } from "vitest";
import { readFeatureMap } from "../src/api/feature-map.js";
import { buildRegistry, declare } from "../src/api/registry.js";
import { integer, object, string } from "../src/api/schema.js";
import { type ChatTool, ChatToolBroker, chatCallContext, featureMapTools } from "../src/core/chat-agent-tools.js";
import { chatTools } from "../src/core/chat-agent.js";

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
