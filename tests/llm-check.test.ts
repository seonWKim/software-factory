import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Plugins, loadConfig } from "../src/compose.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { EgressChannel, EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import {
  OUTPUT_SCHEMA,
  PLAIN_PROMPT,
  SCHEMA_PROMPT,
  llmCheckFromPlugins,
  parseLlmCheckArgs,
  runLlmCheck,
} from "../src/llm-check.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import { doctor } from "../src/setup.js";

const FAKE_KEY = `sk-ant-api03-${"A".repeat(40)}`;

/** Records every scan; delegates to the real pattern scanner. */
class RecordingScanner implements EgressScanner {
  readonly calls: { channel: EgressChannel; content: string }[] = [];
  private readonly inner = new PatternEgressScanner(async () => []);
  async scan(channel: EgressChannel, content: string): Promise<ScanResult> {
    this.calls.push({ channel, content });
    return this.inner.scan(channel, content);
  }
}

type Reply = Partial<LLMResponse> | Error;

/** Answers the plain request with `plain` and the schema request with `schema`; counts and records calls. */
class FakeProvider implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly plain: Reply = {},
    private readonly schema: Reply = {},
    private readonly clock?: FakeClock,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    this.clock?.advance(req.output_schema ? 250 : 120);
    const r = req.output_schema ? this.schema : this.plain;
    if (r instanceof Error) throw r;
    return {
      text: req.output_schema ? '{"ok":true,"n":5}' : "ok",
      stop_reason: "end",
      usage: { input_tokens: 11, output_tokens: 3, cost_usd: null },
      ...(req.output_schema ? { parsed: { ok: true, n: 5 } } : {}),
      ...r,
    };
  }
}

async function check(provider: LLMProvider, opts: { clock?: FakeClock; modelClass?: "cheap" | "standard" | "strong" } = {}) {
  const scanner = new RecordingScanner();
  const printed: string[] = [];
  const result = await runLlmCheck({
    provider,
    providerName: "fake-llm",
    modelClass: opts.modelClass ?? "cheap",
    scanner,
    clock: opts.clock ?? new FakeClock(),
    print: (l) => printed.push(l),
  });
  return { result, printed, scanner, out: printed.join("\n") };
}

describe("llm-check: arguments", () => {
  it("defaults to cheap, accepts standard and strong, rejects anything else with one line", () => {
    expect(parseLlmCheckArgs([])).toEqual({ model: "cheap" });
    expect(parseLlmCheckArgs(["--model", "cheap"])).toEqual({ model: "cheap" });
    expect(parseLlmCheckArgs(["--model", "standard"])).toEqual({ model: "standard" });
    expect(parseLlmCheckArgs(["--model", "strong"])).toEqual({ model: "strong" });
    for (const bad of [["--model", "opus"], ["--model", "medium"], ["--model"], ["--fast"]]) {
      const r = parseLlmCheckArgs(bad);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error).not.toContain("\n");
    }
  });
});

describe("llm-check: the check function", () => {
  it("sends the plain and the schema request, both with data_env test, in the chosen model class", async () => {
    const provider = new FakeProvider();
    await check(provider, { modelClass: "strong" });
    expect(provider.requests).toHaveLength(2);
    const [plain, schema] = provider.requests;
    expect(plain!.messages).toEqual([{ role: "user", content: PLAIN_PROMPT }]);
    expect(plain!.output_schema).toBeUndefined();
    expect(schema!.messages).toEqual([{ role: "user", content: SCHEMA_PROMPT }]);
    expect(schema!.output_schema).toEqual(OUTPUT_SCHEMA);
    expect(OUTPUT_SCHEMA).toMatchObject({ properties: { ok: { type: "boolean" }, n: { type: "number" } } });
    for (const r of provider.requests) {
      expect(r.data_env).toBe("test");
      expect(r.model_class).toBe("strong");
    }
  });

  it("valid responses: ok, and every field is printed for each request", async () => {
    const clock = new FakeClock();
    const { result, printed } = await check(
      new FakeProvider({}, { usage: { input_tokens: 20, output_tokens: 7, cost_usd: 0.0012 } }, clock),
      { clock },
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    const plain = printed.find((l) => l.startsWith("plain:"))!;
    const schema = printed.find((l) => l.startsWith("schema:"))!;
    for (const line of [plain, schema]) {
      expect(line).toContain("provider=fake-llm");
      expect(line).toContain("model=cheap");
      expect(line).toContain("stop_reason=end");
      expect(line).toMatch(/elapsed_ms=\d+/);
      expect(line).toMatch(/input_tokens=\d+/);
      expect(line).toMatch(/output_tokens=\d+/);
      expect(line).toMatch(/cost=/);
      expect(line).toMatch(/parsed=/);
    }
    expect(plain).toContain("elapsed_ms=120");
    expect(plain).toContain("cost=unknown");
    expect(plain).toContain("input_tokens=11");
    expect(schema).toContain("elapsed_ms=250");
    expect(schema).toContain("cost=$0.0012");
    expect(schema).toContain("input_tokens=20");
    expect(schema).toContain("output_tokens=7");
    expect(schema).toContain("parsed=matches");
    expect(printed.at(-1)).toMatch(/^llm-check ok/);
  });

  it("parsed failing the schema: exit 1, and the reason names the schema mismatch", async () => {
    const { result, printed } = await check(new FakeProvider({}, { parsed: { ok: "yes", n: 5 } }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match the schema/);
    expect(printed.find((l) => l.startsWith("schema:"))).toContain("parsed=mismatch");
    expect(printed.at(-1)).toMatch(/^llm-check FAIL: .*schema/);
    expect(printed.filter((l) => l.startsWith("llm-check"))).toHaveLength(1);
  });

  it("parsed with n other than 5: exit 1", async () => {
    const { result } = await check(new FakeProvider({}, { parsed: { ok: true, n: 4 } }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/n is 4, expected 5/);
  });

  it("stop_reason error: exit 1", async () => {
    const { result, printed } = await check(new FakeProvider({ stop_reason: "error", text: "overloaded" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stop_reason error: overloaded/);
    expect(printed.find((l) => l.startsWith("plain:"))).toContain("stop_reason=error");
  });

  it("a provider that throws: exit 1 with the error message", async () => {
    const { result, out } = await check(new FakeProvider(new Error("connection refused"), new Error("connection refused")));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/threw: connection refused/);
    expect(out).toContain("connection refused");
  });

  it("a secret-shaped string in the provider's error text never appears; the withheld marker does", async () => {
    for (const provider of [
      new FakeProvider(new Error(`401 invalid x-api-key ${FAKE_KEY}`)),
      new FakeProvider({ stop_reason: "error", text: `bad key ${FAKE_KEY}` }),
    ]) {
      const { result, out, printed } = await check(provider);
      expect(result.ok).toBe(false);
      expect(out).not.toContain(FAKE_KEY);
      expect(out).not.toContain("sk-ant-");
      expect(result.reason).not.toContain("sk-ant-");
      expect(out).toContain("[withheld: anthropic_key]");
      expect(printed.at(-1)).toContain("[withheld: anthropic_key]");
    }
  });

  it("every printed line passes through the scanner on channel log first", async () => {
    const { printed, scanner } = await check(new FakeProvider(new Error("boom")));
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(scanner.calls.some((c) => c.channel === "log" && c.content === line)).toBe(true);
    }
    expect(scanner.calls.every((c) => c.channel === "log")).toBe(true);
  });
});

// Through the registry: a throwaway repo root, a fake llm plugin and a recording egress plugin.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function root(llm: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-llm-check-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const plugins = { ...(REAL.plugins as Record<string, unknown>), llm, egress: "recording", updater: "none" };
  writeFileSync(
    join(dir, "factory.config.json"),
    JSON.stringify({ ...REAL, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt" }),
  );
  const secrets = mkdtempSync(join(tmpdir(), "sf-llm-check-secrets-"));
  writeFileSync(join(secrets, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=\n", { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(secrets, ".env"));
  // doctor's `claude --version` finds nothing: no process is started by these tests.
  vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-path-")));
  return dir;
}

function registry(providers: Record<string, LLMProvider>, scanner: RecordingScanner): Registry {
  let r = withPlugin(REGISTRY, "egress", "recording", () => scanner);
  for (const [name, p] of Object.entries(providers)) r = withPlugin(r, "llm", name, () => p);
  return r;
}

describe("llm-check: built through the registry", () => {
  it("runs against any registered llm plugin by its configured name, with the scanner from Plugins", async () => {
    const scanner = new RecordingScanner();
    const first = new FakeProvider();
    const second = new FakeProvider({}, { parsed: { ok: false, n: 5 } });
    const reg = registry({ "fake-one": first, "fake-two": second }, scanner);

    for (const [name, provider] of [["fake-one", first], ["fake-two", second]] as const) {
      const loaded = await loadConfig(root(name), { registry: reg });
      const printed: string[] = [];
      const r = await llmCheckFromPlugins(new Plugins(loaded), "cheap", (l) => printed.push(l));
      expect(r.ok).toBe(true);
      expect(provider.requests).toHaveLength(2);
      expect(printed.find((l) => l.startsWith("plain:"))).toContain(`provider=${name}`);
      for (const line of printed) expect(scanner.calls.some((c) => c.channel === "log" && c.content === line)).toBe(true);
    }
  });
});

describe("doctor and the LLM check", () => {
  it("plain doctor makes zero provider calls", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new FakeProvider();
    const loaded = await loadConfig(root("counting"), { registry: registry({ counting: provider }, new RecordingScanner()) });
    await doctor(loaded);
    expect(provider.requests).toHaveLength(0);
  });

  it("doctor --llm makes exactly two calls and adds one line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new FakeProvider();
    const loaded = await loadConfig(root("counting"), { registry: registry({ counting: provider }, new RecordingScanner()) });
    await doctor(loaded, { llm: true });
    expect(provider.requests).toHaveLength(2);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => /llm-check (ok|FAIL)/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok\s+llm-check ok/);
  });

  it("doctor --llm shows FAIL and exits 1 when the check fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new FakeProvider({ stop_reason: "error", text: "nope" });
    const loaded = await loadConfig(root("counting"), { registry: registry({ counting: provider }, new RecordingScanner()) });
    expect(await doctor(loaded, { llm: true })).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => /llm-check (ok|FAIL)/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^FAIL\s+llm-check FAIL: plain request stop_reason error: nope/);
  });
});
