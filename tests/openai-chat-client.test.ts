import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChatRequest, type ChatResult, chatCompletion, chatCompletionsUrl, retryAfterResetAt } from "../src/impl/openai/chat-client.js";
import { type FakeOpenAIServer, type ScriptedResponse, completion, startFakeOpenAIServer } from "./helpers/fake-openai-server.js";

const KEY = "sk-test-key-123";
const REQUEST: ChatRequest = { model: "fake-model-1", messages: [{ role: "user", content: "hi" }] };

let servers: FakeOpenAIServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function serve(...script: ScriptedResponse[]): Promise<FakeOpenAIServer> {
  const s = await startFakeOpenAIServer(script);
  servers.push(s);
  return s;
}

/** A port nothing listens on: a server bound, then closed. */
async function deadOrigin(): Promise<string> {
  const s = await startFakeOpenAIServer([]);
  await s.close();
  return s.origin;
}

function failure(r: ChatResult) {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

describe("chat client: request", () => {
  it("posts JSON to <base_url>/chat/completions with the bearer key", async () => {
    const s = await serve({ status: 200, body: completion() });
    const r = await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST });
    expect(r.ok).toBe(true);
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req.body)).toEqual(REQUEST);
  });

  it("a trailing slash on base_url does not produce a double slash", async () => {
    const s = await serve({ status: 200, body: completion() }, { status: 200, body: completion() });
    await chatCompletion({ baseUrl: `${s.baseUrl}/`, apiKey: KEY, request: REQUEST });
    await chatCompletion({ baseUrl: `${s.baseUrl}//`, apiKey: KEY, request: REQUEST });
    expect(s.requests.map((r) => r.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(chatCompletionsUrl("https://x.test/v1/")).toBe("https://x.test/v1/chat/completions");
  });
});

describe("chat client: 200", () => {
  it("returns the text, an empty tool call list, the usage and the reported model", async () => {
    const s = await serve({ status: 200, body: completion({ text: "the answer", model: "reported-model", prompt_tokens: 42, completion_tokens: 5 }) });
    const r = await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST });
    expect(r).toEqual({ ok: true, text: "the answer", tool_calls: [], usage: { input_tokens: 42, output_tokens: 5 }, model: "reported-model" });
  });

  it("returns the tool calls", async () => {
    const call = { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } };
    const s = await serve({ status: 200, body: completion({ text: null, tool_calls: [call] }) });
    const r = await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST });
    if (!r.ok) throw new Error(r.message);
    expect(r.tool_calls).toEqual([call]);
    expect(r.text).toBe("");
  });

  it("a 200 that is not a chat completion is bad_response", async () => {
    const s = await serve({ status: 200, body: "not json" }, { status: 200, body: { choices: [] } });
    expect(failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST })).code).toBe("bad_response");
    expect(failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST })).code).toBe("bad_response");
  });
});

describe("chat client: 429", () => {
  const NOW = Date.parse("2026-11-07T10:00:00Z");

  it("Retry-After in seconds gives reset_at that many seconds from now, in ISO-8601 UTC", async () => {
    const s = await serve({ status: 429, headers: { "retry-after": "30" }, body: {} });
    const r = failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST, now: () => NOW }));
    expect(r.code).toBe("rate_limited");
    expect(r.reset_at).toBe("2026-11-07T10:00:30.000Z");
    expect(s.requests).toHaveLength(1);
  });

  it("Retry-After as an HTTP date gives that date in ISO-8601 UTC", async () => {
    const s = await serve({ status: 429, headers: { "retry-after": "Sat, 07 Nov 2026 10:05:00 GMT" }, body: {} });
    const r = failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST, now: () => NOW }));
    expect(r.code).toBe("rate_limited");
    expect(r.reset_at).toBe("2026-11-07T10:05:00.000Z");
  });

  it("no Retry-After gives rate_limited with no reset_at", async () => {
    const s = await serve({ status: 429, body: {} });
    const r = failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST }));
    expect(r.code).toBe("rate_limited");
    expect(r).not.toHaveProperty("reset_at");
  });

  it("an unparsable Retry-After gives no reset_at", () => {
    expect(retryAfterResetAt("soon", NOW)).toBeUndefined();
    expect(retryAfterResetAt(null, NOW)).toBeUndefined();
  });
});

describe("chat client: other failures, no retry", () => {
  it.each([400, 401, 403, 404, 500, 502, 503])("HTTP %i is a failure that is not rate_limited, after exactly one request", async (status) => {
    const s = await serve({ status, body: { error: { message: "nope" } } }, { status: 200, body: completion() });
    const r = failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST }));
    expect(r.code).toBe("http_error");
    expect(r.status).toBe(status);
    expect(s.requests).toHaveLength(1);
  });

  it("the server dropping the connection is network_error, after exactly one request", async () => {
    const s = await serve({ destroy: true }, { status: 200, body: completion() });
    const r = failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST }));
    expect(r.code).toBe("network_error");
    expect(s.requests).toHaveLength(1);
  });

  it("connection refused is network_error", async () => {
    const r = failure(await chatCompletion({ baseUrl: `${await deadOrigin()}/v1`, apiKey: KEY, request: REQUEST }));
    expect(r.code).toBe("network_error");
  });
});

describe("chat client: abort", () => {
  it("an aborted request is aborted, and the server records it cancelled", async () => {
    const s = await serve({ hang: true });
    const ac = new AbortController();
    const pending = chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST, signal: ac.signal });
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    ac.abort();
    const r = failure(await pending);
    expect(r.code).toBe("aborted");
    await vi.waitFor(() => expect(s.requests[0]!.cancelled).toBe(true));
  });

  it("an already-aborted signal sends nothing", async () => {
    const s = await serve({ status: 200, body: completion() });
    const ac = new AbortController();
    ac.abort();
    expect(failure(await chatCompletion({ baseUrl: s.baseUrl, apiKey: KEY, request: REQUEST, signal: ac.signal })).code).toBe("aborted");
    expect(s.requests).toHaveLength(0);
  });
});

describe("chat client: the key never leaks", () => {
  const CANARY = "sk-canary-7f3e9a1b2c4d";

  it("401, 429, a 500 echoing the key, a network error and an abort never return or throw the key", async () => {
    const s = await serve(
      { status: 401, body: { error: { message: `invalid key ${CANARY}` } } },
      { status: 429, headers: { "retry-after": "5" }, body: { error: { message: `slow down ${CANARY}` } } },
      { status: 500, body: `internal error for Authorization: Bearer ${CANARY}` },
      { destroy: true },
      { hang: true },
    );
    const call = (signal?: AbortSignal) =>
      chatCompletion({ baseUrl: s.baseUrl, apiKey: CANARY, request: REQUEST, ...(signal ? { signal } : {}) }).catch((e: unknown) => {
        throw new Error(`chatCompletion threw: ${String(e)}`);
      });
    const results: unknown[] = [];
    results.push(await call(), await call(), await call(), await call());
    const ac = new AbortController();
    const pending = call(ac.signal);
    await vi.waitFor(() => expect(s.requests).toHaveLength(5));
    ac.abort();
    results.push(await pending);
    results.push(await chatCompletion({ baseUrl: `${await deadOrigin()}/v1`, apiKey: CANARY, request: REQUEST }));

    expect(results.map((r) => (r as ChatResult).ok)).toEqual([false, false, false, false, false, false]);
    expect((results as { code: string }[]).map((r) => r.code)).toEqual([
      "http_error", "rate_limited", "http_error", "network_error", "aborted", "network_error",
    ]);
    for (const r of results) expect(JSON.stringify(r)).not.toContain(CANARY);
    // The key did go out, in the header only.
    expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${CANARY}`);
  });

  it("a 200 echoing the key returns it redacted", async () => {
    const s = await serve({ status: 200, body: completion({ text: `your key is ${CANARY}`, model: CANARY }) });
    const r = await chatCompletion({ baseUrl: s.baseUrl, apiKey: CANARY, request: REQUEST });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

describe("no vendor SDK", () => {
  const ROOT = join(import.meta.dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("no file under src/ or tests/ imports an OpenAI or Anthropic SDK package", () => {
    const vendor = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:openai|@openai\/[^"']*|@anthropic-ai\/[^"']*|@azure\/openai)["']/;
    const hits = [...files(join(ROOT, "src")), ...files(join(ROOT, "tests"))].filter((f) => vendor.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the chat client uses the global fetch and imports nothing", () => {
    const text = readFileSync(join(ROOT, "src", "impl", "openai", "chat-client.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).toContain("await fetch(");
  });
});
