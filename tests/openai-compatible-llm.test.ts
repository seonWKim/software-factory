import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Plugins, loadConfig } from "../src/compose.js";
import { OpenAICompatibleLLMProvider } from "../src/impl/llm/openai-compatible-llm-provider.js";
import openaiCompatible from "../src/impl/llm/openai-compatible.plugin.js";
import type { OpenAICompatibleConfig } from "../src/impl/openai/config.js";
import type { LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import { llmCheckFromPlugins } from "../src/llm-check.js";
import { REGISTRY } from "../src/plugins.js";
import { doctor } from "../src/setup.js";
import { type FakeOpenAIServer, type ScriptedResponse, completion, startFakeOpenAIServer } from "./helpers/fake-openai-server.js";

const KEY = "sk-openai-compatible-test-key-0123456789";
const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const MODELS = { cheap: "fake-cheap", standard: "fake-standard", strong: "fake-strong" };
const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, n: { type: "number" } },
  required: ["ok", "n"],
  additionalProperties: false,
};

let servers: FakeOpenAIServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function serve(...script: ScriptedResponse[]): Promise<FakeOpenAIServer> {
  const s = await startFakeOpenAIServer(script);
  servers.push(s);
  return s;
}

class MapSecrets implements SecretStore {
  readonly asked: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    this.asked.push(name);
    const v = this.values[name];
    if (v === undefined) return null;
    return { name, reveal: () => v, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

function provider(config: OpenAICompatibleConfig | undefined, secrets: SecretStore = new MapSecrets({ OPENAI_COMPATIBLE_API_KEY: KEY })) {
  return new OpenAICompatibleLLMProvider({ secrets, config });
}

const REQ: LLMRequest = { model_class: "cheap", messages: [{ role: "user", content: "hi" }], max_tokens: 64, data_env: "test" };

function noKey(r: LLMResponse) {
  expect(JSON.stringify(r)).not.toContain(KEY);
}

describe("openai-compatible descriptor", () => {
  it("registers under llm, is not the default, and declares exactly one secret", () => {
    expect(openaiCompatible.kind).toBe("llm");
    expect(openaiCompatible.name).toBe("openai-compatible");
    expect(openaiCompatible.default).toBeUndefined();
    expect(REGISTRY.llm.plugins["openai-compatible"]).toBe(openaiCompatible.create);
    expect(REGISTRY.llm.defaults.fallback).toBe("claude-cli");
    expect(REGISTRY.llm.secrets["openai-compatible"]!.map((d) => d.name)).toEqual(["OPENAI_COMPATIBLE_API_KEY"]);
    const purpose = openaiCompatible.secrets![0]!.purpose;
    expect(purpose.trim()).not.toBe("");
    expect(purpose).not.toContain("\n");
  });
});

describe("OpenAICompatibleLLMProvider", () => {
  it("refuses prod data without an HTTP request", async () => {
    const s = await serve({ status: 200, body: completion() });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }).complete({ ...REQ, data_env: "prod" });
    expect(r.stop_reason).toBe("refused");
    expect(s.requests).toHaveLength(0);
  });

  it("sends the class's model and a Bearer key read from the SecretStore, not process.env", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "sk-from-env-must-not-be-used");
    const secrets = new MapSecrets({ OPENAI_COMPATIBLE_API_KEY: KEY });
    const s = await serve({ status: 200, body: completion({ text: "ok" }) });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }, secrets).complete({ ...REQ, model_class: "strong", system: "be brief" });
    expect(r).toMatchObject({ text: "ok", stop_reason: "end" });
    expect(secrets.asked).toEqual(["OPENAI_COMPATIBLE_API_KEY"]);
    expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(s.requests[0]!.body);
    expect(body.model).toBe("fake-strong");
    expect(body.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
    expect(body.response_format).toBeUndefined();
  });

  it("maps usage from prompt_tokens and completion_tokens; cost_usd is null", async () => {
    const s = await serve(
      { status: 200, body: completion({ prompt_tokens: 42, completion_tokens: 9 }) },
      { status: 200, body: completion({ text: '{"ok":true,"n":5}', prompt_tokens: 3, completion_tokens: 4 }) },
    );
    const p = provider({ base_url: s.baseUrl, models: MODELS });
    expect((await p.complete(REQ)).usage).toEqual({ input_tokens: 42, output_tokens: 9, cost_usd: null });
    expect((await p.complete({ ...REQ, output_schema: SCHEMA })).usage).toEqual({ input_tokens: 3, output_tokens: 4, cost_usd: null });
  });

  it("with output_schema: sends response_format json_schema strict, returns end and the parsed value", async () => {
    const s = await serve({ status: 200, body: completion({ text: '{"ok":true,"n":5}' }) });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }).complete({ ...REQ, output_schema: SCHEMA });
    expect(r.stop_reason).toBe("end");
    expect(r.parsed).toEqual({ ok: true, n: 5 });
    const body = JSON.parse(s.requests[0]!.body);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", schema: SCHEMA, strict: true } });
  });

  it("with output_schema: a reply that is not JSON is an error", async () => {
    const s = await serve({ status: 200, body: completion({ text: "sure, ok is true" }) });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }).complete({ ...REQ, output_schema: SCHEMA });
    expect(r.stop_reason).toBe("error");
    expect(r.parsed).toBeUndefined();
    expect(r.text).toMatch(/not JSON/);
  });

  it("with output_schema: JSON that does not match the schema is an error", async () => {
    const s = await serve({ status: 200, body: completion({ text: '{"ok":"yes"}' }) });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }).complete({ ...REQ, output_schema: SCHEMA });
    expect(r.stop_reason).toBe("error");
    expect(r.parsed).toBeUndefined();
    expect(r.text).toMatch(/does not match/);
  });

  it("an HTTP error, a 429 and a network failure each return error with a message, never the key", async () => {
    const s = await serve(
      { status: 500, body: { error: { message: `boom for ${KEY}` } } },
      { status: 429, body: {}, headers: { "retry-after": "30" } },
      { destroy: true },
    );
    const p = provider({ base_url: s.baseUrl, models: MODELS });
    const http = await p.complete(REQ);
    const limited = await p.complete(REQ);
    const network = await p.complete(REQ);
    expect(s.requests).toHaveLength(3);
    for (const [r, pattern] of [[http, /HTTP 500/], [limited, /429/], [network, /network_error/]] as const) {
      expect(r.stop_reason).toBe("error");
      expect(r.text).toMatch(pattern);
      noKey(r);
    }
  });

  it("a missing key is an error without an HTTP request", async () => {
    const s = await serve({ status: 200, body: completion() });
    const r = await provider({ base_url: s.baseUrl, models: MODELS }, new MapSecrets({})).complete(REQ);
    expect(r.stop_reason).toBe("error");
    expect(r.text).toContain("OPENAI_COMPATIBLE_API_KEY");
    expect(s.requests).toHaveLength(0);
  });
});

// Through the registry: a throwaway repo root selecting openai-compatible.

function root(opts: { baseUrl?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-openai-llm-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const plugins = { ...(REAL.plugins as Record<string, unknown>), llm: "openai-compatible", updater: "none" };
  const config: Record<string, unknown> = { ...REAL, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt" };
  if (opts.baseUrl) config.openai_compatible = { base_url: opts.baseUrl, models: MODELS };
  else delete config.openai_compatible;
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  const secrets = mkdtempSync(join(tmpdir(), "sf-openai-llm-secrets-"));
  writeFileSync(join(secrets, ".env"), `CLAUDE_CODE_OAUTH_TOKEN=\nOPENAI_COMPATIBLE_API_KEY=${KEY}\n`, { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(secrets, ".env"));
  // doctor's `claude --version` finds nothing: no process is started by these tests.
  vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-path-")));
  return dir;
}

const llmLines = (calls: unknown[][]) => calls.map((c) => String(c[0])).filter((l) => /llm-check (ok|FAIL)/.test(l));

describe("openai-compatible selected in config", () => {
  it("loadConfig resolves with a valid openai_compatible block", async () => {
    const s = await serve();
    const loaded = await loadConfig(root({ baseUrl: s.baseUrl }));
    expect(loaded.plugins.llm).toBe("openai-compatible");
  });

  it("without the openai_compatible block: create() does not throw, complete() names the missing block", async () => {
    const loaded = await loadConfig(root({}));
    const p = new Plugins(loaded);
    const llm = await p.llm(await p.secrets());
    const r = await llm.complete(REQ);
    expect(r.stop_reason).toBe("error");
    expect(r.text).toContain("openai_compatible");
  });

  it("plain doctor makes zero HTTP requests to the endpoint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await serve({ status: 200, body: completion() });
    await doctor(await loadConfig(root({ baseUrl: s.baseUrl })));
    expect(s.requests).toHaveLength(0);
  });

  it("doctor --llm makes exactly two requests, plain then json_schema, and prints the summary", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await serve({ status: 200, body: completion({ text: "ok" }) }, { status: 200, body: completion({ text: '{"ok":true,"n":5}' }) });
    const loaded = await loadConfig(root({ baseUrl: s.baseUrl }));
    await doctor(loaded, { llm: true });
    expect(s.requests).toHaveLength(2);
    expect(JSON.parse(s.requests[0]!.body).response_format).toBeUndefined();
    expect(JSON.parse(s.requests[1]!.body).response_format.type).toBe("json_schema");
    const lines = llmLines(log.mock.calls);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok\s+llm-check ok: openai-compatible cheap, both requests end, n = 5/);
    for (const l of log.mock.calls.map((c) => String(c[0]))) expect(l).not.toContain(KEY);
  });

  it("the llm check prints the plain line, the schema line and the summary line", async () => {
    const s = await serve({ status: 200, body: completion({ text: "ok", prompt_tokens: 5, completion_tokens: 1 }) }, { status: 200, body: completion({ text: '{"ok":true,"n":5}' }) });
    const printed: string[] = [];
    const r = await llmCheckFromPlugins(new Plugins(await loadConfig(root({ baseUrl: s.baseUrl }))), "cheap", (l) => printed.push(l));
    expect(r.ok).toBe(true);
    expect(s.requests).toHaveLength(2);
    expect(printed).toHaveLength(3);
    expect(printed[0]).toMatch(/^plain: provider=openai-compatible model=cheap stop_reason=end .*input_tokens=5 output_tokens=1 cost=unknown parsed=n\/a$/);
    expect(printed[1]).toMatch(/^schema: provider=openai-compatible model=cheap stop_reason=end .*cost=unknown parsed=matches$/);
    expect(printed[2]).toBe("llm-check ok: openai-compatible cheap, both requests end, n = 5");
  });
});
