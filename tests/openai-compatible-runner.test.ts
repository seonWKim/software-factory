import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCanary } from "../src/canary.js";
import { loadConfig } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import { TRIAGE_SCHEMA } from "../src/core/outputs.js";
import { Bash, Edit, Glob, Grep, Read, type ToolSpec, Write } from "../src/core/tools/index.js";
import type { RunId, WorkItemId, WorkerId } from "../src/core/types.js";
import { WRITE_TOOLS, Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { OpenAICompatibleConfig } from "../src/impl/openai/config.js";
import { AGENT_FAILED, BASH_REFUSAL, INVALID_OUTPUT, MAX_TOOL_ROUNDS, OpenAICompatibleRunner } from "../src/impl/runner/openai-compatible-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { type AgentRunSpec, toolsNotExposedMessage } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import { REGISTRY } from "../src/plugins.js";
import { type FakeOpenAIServer, type ScriptedResponse, completion, startFakeOpenAIServer } from "./helpers/fake-openai-server.js";
import {
  FakeAuth, FakeBroker, FakeSandbox, FakeSource, MemoryStorage, alice, config as fakeConfig, issueRef, prompts, silent, waitFor,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Issue #194 (phase 4 of #163): the `openai-compatible` AgentRunner. Its tool loop runs against the fake
// OpenAI server; its tools are the shared ones in src/core/tools, run in a real NoOpSandbox folder.

const KEY = "sk-runner-test-key-5f2a9c0b7d1e";
const ENV_SECRET = "ENV-FILE-CONTENT-71b3";
const OUTSIDE_SECRET = "OUTSIDE-CONTENT-a90e";
const DENIED_SECRET = "DENIED-CONTENT-3c55";
const MODELS = { cheap: "m-cheap", standard: "m-standard", strong: "m-strong" };
const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const ANSWER_SCHEMA = { type: "object", required: ["answer"], additionalProperties: false, properties: { answer: { type: "string" } } };

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
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    const v = this.values[name];
    if (v === undefined) return null;
    return { name, reveal: () => v, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

/** A NoOpSandbox that records every command and environment the tools ran with. */
class RecordingSandbox implements Sandbox {
  readonly calls: { cmd: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  private readonly inner = new NoOpSandbox(join(tmpdir(), "sf-oc-runner-unused"));
  create = this.inner.create.bind(this.inner);
  updateBase = this.inner.updateBase.bind(this.inner);
  copyIn = this.inner.copyIn.bind(this.inner);
  copyOut = this.inner.copyOut.bind(this.inner);
  destroy = this.inner.destroy.bind(this.inner);
  exec(h: SandboxHandle, cmd: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, env: opts.env });
    return this.inner.exec(h, cmd, opts);
  }
}

let root: string;
let workdir: string;
let outside: string;
let handle: SandboxHandle;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sf-oc-runner-")));
  workdir = join(root, "run");
  mkdirSync(join(workdir, "docs"), { recursive: true });
  writeFileSync(join(workdir, "docs", "notes.txt"), "the answer is 42\n");
  writeFileSync(join(workdir, "docs", "keyed.txt"), `the key is ${KEY}\n`);
  writeFileSync(join(workdir, ".env"), `X=${ENV_SECRET}\n`);
  mkdirSync(join(workdir, "vault"));
  writeFileSync(join(workdir, "vault", "key.txt"), `${DENIED_SECRET}\n`);
  outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), `${OUTSIDE_SECRET}\n`);
  handle = { id: "sbx_oc", workdir };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    run_id: "run_oc" as RunId,
    work_item_id: "wi_oc" as WorkItemId,
    role: "implement",
    sandbox: handle,
    system_prompt: "You are a test agent.",
    prompt: "Do the task.",
    tools: [Read, Glob, Grep, Write, Edit, Bash],
    tool_grants: [],
    lease_token: 1,
    env_allowlist: {},
    deny_paths: [join(workdir, "vault")],
    writable_paths: [],
    model_class: "standard",
    timeout_ms: 30_000,
    output_schema: ANSWER_SCHEMA,
    signal: new AbortController().signal,
    ...over,
  };
}

function runner(server: FakeOpenAIServer, opts: { sandbox?: Sandbox; now?: () => number; config?: OpenAICompatibleConfig | null } = {}) {
  const config = opts.config === null ? undefined : (opts.config ?? { base_url: server.baseUrl, models: MODELS });
  return new OpenAICompatibleRunner({
    sandbox: opts.sandbox ?? new RecordingSandbox(),
    secrets: new MapSecrets({ OPENAI_COMPATIBLE_API_KEY: KEY }),
    config,
    ...(opts.now && { now: opts.now }),
  });
}

let callN = 0;
/** A 200 completion asking for one tool call. */
function toolCall(name: string, args: unknown, extra: { model?: string; prompt_tokens?: number; completion_tokens?: number } = {}): ScriptedResponse {
  callN++;
  return {
    status: 200,
    body: completion({ text: null, tool_calls: [{ id: `call_${callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }], ...extra }),
  };
}
/** A 200 completion with a final text answer. */
function final(answer: unknown, extra: { model?: string; prompt_tokens?: number; completion_tokens?: number } = {}): ScriptedResponse {
  return { status: 200, body: completion({ text: typeof answer === "string" ? answer : JSON.stringify(answer), ...extra }) };
}

type Body = { model: string; messages: { role: string; content: string | null; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
const body = (s: FakeOpenAIServer, i: number) => JSON.parse(s.requests[i]!.body) as Body;
/** The tool messages the model got back in request `i`. */
const toolMessages = (s: FakeOpenAIServer, i: number) => body(s, i).messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");

describe("registration", () => {
  it("is a runner plugin named openai-compatible, not the default, declaring only OPENAI_COMPATIBLE_API_KEY", () => {
    expect(Object.keys(REGISTRY.runner.plugins)).toContain("openai-compatible");
    expect(REGISTRY.runner.defaults.fallback).toBe("claude-code");
    expect(Object.values(REGISTRY.runner.defaults.platforms)).not.toContain("openai-compatible");
    expect(REGISTRY.runner.secrets["openai-compatible"]!.map((d) => d.name)).toEqual(["OPENAI_COMPATIBLE_API_KEY"]);
  });

  it("a config with runner claude-code and llm claude-cli loads without error", async () => {
    const loaded = await loadConfig(configRoot({ plugins: { runner: "claude-code", llm: "claude-cli" } }).dir);
    expect(loaded.plugins.runner).toBe("claude-code");
    expect(loaded.plugins.llm).toBe("claude-cli");
  });

  it("a config with runner openai-compatible loads, selected by name", async () => {
    const loaded = await loadConfig(configRoot({ plugins: { runner: "openai-compatible" }, baseUrl: "http://127.0.0.1:1/v1" }).dir);
    expect(loaded.plugins.runner).toBe("openai-compatible");
  });
});

describe("refusals before any model call", () => {
  it("reports exposes_tools false and fails a run with tool_grants, with no model call", async () => {
    const s = await serve(final({ answer: "x" }));
    const r = runner(s);
    expect(r.exposes_tools).toBe(false);
    const res = await r.run(spec({ tool_grants: ["github.read_issue"] }));
    expect(res.status).toBe("failed");
    expect(res.error).toBe(toolsNotExposedMessage(["github.read_issue"]));
    expect(s.requests).toHaveLength(0);
  });

  it("fails a run when the openai_compatible block is missing, with no model call", async () => {
    const s = await serve(final({ answer: "x" }));
    const res = await runner(s, { config: null }).run(spec());
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/openai_compatible block is missing/);
    expect(s.requests).toHaveLength(0);
  });
});

describe("the request", () => {
  it("lists exactly spec.tools, by name, in spec order, and uses the class's model name", async () => {
    for (const tools of [[Grep, Read] as ToolSpec[], [...WRITE_TOOLS], [Read, Glob, Grep]]) {
      const s = await serve(final({ answer: "x" }));
      const res = await runner(s).run(spec({ tools }));
      expect(res.status).toBe("completed");
      const b = body(s, 0);
      expect(b.tools!.map((t) => t.function.name)).toEqual(tools.map((t) => t.name));
      expect(b.model).toBe("m-standard");
    }
  });

  it("sends the system prompt and the prompt, with the schema the answer must match", async () => {
    const s = await serve(final({ answer: "x" }));
    await runner(s).run(spec({ system_prompt: "SYS-TEXT", prompt: "USER-TEXT" }));
    const [sys, user] = body(s, 0).messages;
    expect(sys).toMatchObject({ role: "system" });
    expect(sys!.content).toContain("SYS-TEXT");
    expect(sys!.content).toContain(JSON.stringify(ANSWER_SCHEMA));
    expect(user).toEqual({ role: "user", content: "USER-TEXT" });
  });
});

describe("file guards (the shared tools)", () => {
  it("reads a workdir file and returns it to the model", async () => {
    const s = await serve(toolCall("Read", { file_path: "docs/notes.txt" }), final({ answer: "42" }));
    const res = await runner(s).run(spec());
    expect(res).toMatchObject({ status: "completed", output: { answer: "42" } });
    expect(toolMessages(s, 1)[0]).toContain("the answer is 42");
  });

  it("refuses a Read of a .env file or of a path outside the workdir as a tool result, and the run goes on", async () => {
    const s = await serve(
      toolCall("Read", { file_path: ".env" }),
      toolCall("Read", { file_path: join(outside, "secret.txt") }),
      toolCall("Read", { file_path: "vault/key.txt" }),
      final({ answer: "done" }),
    );
    const res = await runner(s).run(spec());
    expect(res).toMatchObject({ status: "completed", output: { answer: "done" } });
    const results = toolMessages(s, 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/^error: refused: .*denied path/);
    expect(results[1]).toMatch(/^error: refused: .*outside the workdir/);
    expect(results[2]).toMatch(/^error: refused: .*denied path/);
    for (const text of [res.transcript, ...s.requests.map((r) => r.body)]) {
      expect(text).not.toContain(ENV_SECRET);
      expect(text).not.toContain(OUTSIDE_SECRET);
      expect(text).not.toContain(DENIED_SECRET);
    }
  });

  it("refuses a Write or Edit outside writable_paths or under deny_paths as a tool result", async () => {
    const s = await serve(
      toolCall("Write", { file_path: join(outside, "new.txt"), content: "x" }),
      toolCall("Write", { file_path: "vault/new.txt", content: "x" }),
      toolCall("Edit", { file_path: join(outside, "secret.txt"), old_string: "OUTSIDE", new_string: "CHANGED" }),
      toolCall("Edit", { file_path: "vault/key.txt", old_string: "DENIED", new_string: "CHANGED" }),
      toolCall("Write", { file_path: "docs/made.txt", content: "made\n" }),
      final({ answer: "done" }),
    );
    const res = await runner(s).run(spec());
    expect(res.status).toBe("completed");
    const results = toolMessages(s, 5);
    expect(results.slice(0, 4).every((r) => r.startsWith("error: refused:"))).toBe(true);
    expect(results[4]).not.toMatch(/^error/);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(workdir, "vault", "new.txt"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toContain("OUTSIDE");
    expect(readFileSync(join(workdir, "vault", "key.txt"), "utf8")).toContain("DENIED");
    expect(readFileSync(join(workdir, "docs", "made.txt"), "utf8")).toBe("made\n");
  });

  it("refuses every Bash call before it runs, as a tool result, and the run goes on", async () => {
    const marker = join(workdir, "bash-ran");
    const sandbox = new RecordingSandbox();
    const s = await serve(
      toolCall("Bash", { command: `touch ${marker}; cat ${join(outside, "secret.txt")}` }),
      toolCall("Bash", { command: "echo hi" }),
      final({ answer: "done" }),
    );
    const res = await runner(s, { sandbox }).run(spec());
    expect(res).toMatchObject({ status: "completed", output: { answer: "done" } });
    expect(toolMessages(s, 2)).toEqual([`error: ${BASH_REFUSAL}`, `error: ${BASH_REFUSAL}`]);
    expect(existsSync(marker)).toBe(false);
    expect(sandbox.calls).toHaveLength(0);
    expect(res.transcript).not.toContain(OUTSIDE_SECRET);
  });

  it("refuses a tool the spec does not offer", async () => {
    const s = await serve(toolCall("Write", { file_path: "docs/x.txt", content: "x" }), final({ answer: "done" }));
    const res = await runner(s).run(spec({ tools: [Read, Grep] }));
    expect(res.status).toBe("completed");
    expect(toolMessages(s, 1)[0]).toBe("error: tool Write is not available to this run");
    expect(existsSync(join(workdir, "docs", "x.txt"))).toBe(false);
  });
});

describe("the final answer", () => {
  it("not JSON: completed with no output and an invalid_output error", async () => {
    const s = await serve(final("I think the answer is 42."));
    const res = await runner(s).run(spec());
    expect(res.status).toBe("completed");
    expect(res.output).toBeNull();
    expect(res.error).toMatch(new RegExp(`^${INVALID_OUTPUT}: .*not JSON`));
  });

  it("JSON that does not match output_schema: completed with no output and an invalid_output error", async () => {
    const s = await serve(final({ answer: 42, extra: true }));
    const res = await runner(s).run(spec());
    expect(res.status).toBe("completed");
    expect(res.output).toBeNull();
    expect(res.error).toMatch(new RegExp(`^${INVALID_OUTPUT}: .*does not match`));
  });

  it("accepts JSON inside one code fence", async () => {
    const s = await serve(final('```json\n{"answer":"fenced"}\n```'));
    expect((await runner(s).run(spec())).output).toEqual({ answer: "fenced" });
  });
});

describe("loop limits, timeout and abort", () => {
  it(`past ${MAX_TOOL_ROUNDS} tool rounds the run ends failed with agent_failed`, async () => {
    const script = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolCall("Read", { file_path: "docs/notes.txt" }));
    const s = await serve(...script, final({ answer: "never" }));
    const res = await runner(s).run(spec());
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(new RegExp(`^${AGENT_FAILED}:`));
    expect(s.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
  });

  it(`${MAX_TOOL_ROUNDS} tool rounds then an answer completes`, async () => {
    const script = Array.from({ length: MAX_TOOL_ROUNDS }, () => toolCall("Glob", { pattern: "docs/*.txt" }));
    const s = await serve(...script, final({ answer: "ok" }));
    const res = await runner(s).run(spec());
    expect(res).toMatchObject({ status: "completed", output: { answer: "ok" } });
  });

  it("timeout_ms ends the run timed_out at that time and cancels the in-flight request", async () => {
    const s = await serve({ hang: true });
    const started = Date.now();
    const res = await runner(s).run(spec({ timeout_ms: 300 }));
    const took = Date.now() - started;
    expect(res.status).toBe("timed_out");
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(5_000);
    await waitFor(() => s.requests[0]?.cancelled === true, "the request to be cancelled");
  });

  it("an AbortSignal fired mid-run ends the run aborted and cancels the in-flight request", async () => {
    const s = await serve(toolCall("Read", { file_path: "docs/notes.txt" }), { hang: true });
    const ac = new AbortController();
    const done = runner(s).run(spec({ signal: ac.signal }));
    await waitFor(() => s.requests.length === 2, "the second request");
    ac.abort();
    const res = await done;
    expect(res.status).toBe("aborted");
    await waitFor(() => s.requests[1]!.cancelled, "the request to be cancelled");
  });

  it("an already aborted signal makes no model call", async () => {
    const s = await serve(final({ answer: "x" }));
    const ac = new AbortController();
    ac.abort();
    expect((await runner(s).run(spec({ signal: ac.signal }))).status).toBe("aborted");
    expect(s.requests).toHaveLength(0);
  });
});

describe("errors and usage", () => {
  it("HTTP 429 with Retry-After gives rate_limited with reset_at, and no retry", async () => {
    const now = Date.parse("2026-11-07T10:00:00.000Z");
    const s = await serve({ status: 429, headers: { "retry-after": "30" }, body: {} }, final({ answer: "x" }));
    const res = await runner(s, { now: () => now }).run(spec());
    expect(res.status).toBe("rate_limited");
    expect(res.reset_at).toBe("2026-11-07T10:00:30.000Z");
    expect(s.requests).toHaveLength(1);
  });

  it("HTTP 429 with no Retry-After gives rate_limited with no reset_at", async () => {
    const s = await serve({ status: 429, body: {} });
    const res = await runner(s).run(spec());
    expect(res.status).toBe("rate_limited");
    expect(res.reset_at).toBeUndefined();
  });

  it("any other error gives failed, with no retry", async () => {
    for (const bad of [{ status: 500, body: { error: "boom" } }, { status: 400, body: {} }, { destroy: true as const }, { status: 200, body: "not json" }]) {
      const s = await serve(bad, final({ answer: "x" }));
      const res = await runner(s).run(spec());
      expect(res.status, JSON.stringify(bad)).toBe("failed");
      expect(s.requests).toHaveLength(1);
    }
  });

  it("usage sums tokens over every call; usage.model is the model the response reports", async () => {
    const s = await serve(
      toolCall("Read", { file_path: "docs/notes.txt" }, { prompt_tokens: 100, completion_tokens: 10, model: "served-a" }),
      toolCall("Grep", { pattern: "answer" }, { prompt_tokens: 200, completion_tokens: 20, model: "served-a" }),
      final({ answer: "42" }, { prompt_tokens: 300, completion_tokens: 30, model: "served-b" }),
    );
    const res = await runner(s).run(spec());
    expect(res.usage).toMatchObject({ input_tokens: 600, output_tokens: 60, cost_usd: null, model: "served-b" });
  });

  it("usage also counts the calls of a run that then fails", async () => {
    const s = await serve(toolCall("Read", { file_path: "docs/notes.txt" }, { prompt_tokens: 5, completion_tokens: 2 }), { status: 500, body: {} });
    const res = await runner(s).run(spec());
    expect(res.status).toBe("failed");
    expect(res.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
  });
});

describe("the API key stays out of every output", () => {
  it("is not in a prompt, a request body, the transcript, a tool result, a tool environment or a log line", async () => {
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    }
    const sandbox = new RecordingSandbox();
    const s = await serve(
      toolCall("Read", { file_path: "docs/keyed.txt" }),
      toolCall("Bash", { command: "echo $OPENAI_COMPATIBLE_API_KEY" }),
      toolCall("Grep", { pattern: "key is" }),
      final({ answer: "done" }),
    );
    const res = await runner(s, { sandbox }).run(spec({ prompt: `the prompt mentions ${KEY}`, system_prompt: `sys ${KEY}` }));
    expect(res.status).toBe("completed");
    // The key goes only into the Authorization header.
    expect(s.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    const outputs = [
      ...s.requests.map((r) => r.body),
      res.transcript,
      JSON.stringify(res),
      ...toolMessages(s, 3),
      ...sandbox.calls.map((c) => JSON.stringify(c)),
      ...logged,
    ];
    expect(sandbox.calls.length).toBeGreaterThan(0);
    for (const text of outputs) expect(text).not.toContain(KEY);
    // The Read did reach the file: its text came back with the key scrubbed.
    expect(toolMessages(s, 3)[0]).toContain("the key is [redacted]");
  });
});

// --- Through the worker ---------------------------------------------------------------------------------------

const TRIAGE_OUT = {
  in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
  problem: "Add a CI scope gate",
  decisions: [],
  done_criteria: ["CI fails when files outside allowed_paths change"],
  desired_output: "workflow + test",
  in_scope: ["CI"],
  out_of_scope: ["the rest"],
  allowed_paths: [".github/workflows/"],
  files_to_change: [".github/workflows/scope.yml"],
  tier: 2,
  tier_reason: "CI config",
  estimated_lines: 40,
  estimated_files: 2,
};

async function factoryWith(script: ScriptedResponse[]) {
  const s = await serve(...script);
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const scanner = new PatternEgressScanner(async () => [KEY]);
  // Specs auto-approved (tier 2 < 3), so implement and review follow triage.
  const cfg = { ...fakeConfig, dials: { spec_gate_min_tier: 3 as const, auto_merge_max_tier: 0 as const } };
  const runner = new OpenAICompatibleRunner({ sandbox, secrets: new MapSecrets({ OPENAI_COMPATIBLE_API_KEY: KEY }), config: { base_url: s.baseUrl, models: MODELS } });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "CI gate", body: "please" });
  await step();
  const item = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  return { s, store, item, runs: () => store.listRuns(item.id) };
}

describe("through the worker", () => {
  it("a triage, an implement and a review run each complete end to end", async () => {
    const f = await factoryWith([
      toolCall("Glob", { pattern: "**/*.yml" }),
      final(TRIAGE_OUT),
      toolCall("Bash", { command: "npm test" }),
      final({ summary: "added the gate", next_steps: "none" }),
      final({ verdict: "pass", tier: 2, findings: [], summary: "looks right" }),
    ]);
    const runs = await f.runs();
    expect(runs.map((r) => [r.kind, r.outcome?.status])).toEqual([
      ["triage", "succeeded"],
      ["implement", "succeeded"],
      ["review", "succeeded"],
    ]);
    expect((await f.store.getWorkItem(f.item.id))!).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    // Each role got the worker's tools, and Bash was refused inside the implement run.
    expect(body(f.s, 0).tools!.map((t) => t.function.name)).toEqual(["Read", "Glob", "Grep"]);
    expect(body(f.s, 2).tools!.map((t) => t.function.name)).toEqual(WRITE_TOOLS.map((t) => t.name));
    expect(toolMessages(f.s, 3)).toEqual([`error: ${BASH_REFUSAL}`]);
    expect(f.s.requests).toHaveLength(5);
  });

  it("an answer that does not match the schema ends the run as invalid_output", async () => {
    const f = await factoryWith([final("not json"), final({ ...TRIAGE_OUT, tier: 9 }), final("x"), final("x")]);
    const triage = (await f.runs()).filter((r) => r.kind === "triage");
    expect(triage[0]!.outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
  });

  it("a loop past the maximum tool rounds ends the run as agent_failed", async () => {
    const script = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolCall("Glob", { pattern: "*" }));
    const f = await factoryWith(script);
    const triage = (await f.runs()).filter((r) => r.kind === "triage");
    expect(triage[0]!.outcome).toMatchObject({ status: "failed", error_code: "agent_failed" });
  });
});

// --- Config and the G6 canary ---------------------------------------------------------------------------------

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

/** A throwaway repo root with its own config, prompts, a git repo with an origin, and a secret file. */
function configRoot(opts: { plugins?: Record<string, string>; baseUrl?: string }): { dir: string; secretsFile: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-oc-root-")));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "clone", "--quiet", origin, repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "main");
  const plugins = { ...(REAL.plugins as Record<string, unknown>), updater: "none", sandbox: "noop", ...opts.plugins };
  const config: Record<string, unknown> = {
    ...REAL, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt",
    repo: { ...(REAL.repo as Record<string, unknown>), path: repo },
  };
  if (opts.baseUrl) config.openai_compatible = { base_url: opts.baseUrl, models: MODELS };
  else delete config.openai_compatible;
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  const secrets = realpathSync(mkdtempSync(join(tmpdir(), "sf-oc-secrets-")));
  const secretsFile = join(secrets, ".env");
  writeFileSync(secretsFile, `CLAUDE_CODE_OAUTH_TOKEN=\nOPENAI_COMPATIBLE_API_KEY=${KEY}\n`, { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", secretsFile);
  return { dir, secretsFile };
}

describe("G6 canary", () => {
  it("runCanary with this runner selected reports passed", async () => {
    // The config first: the planted file's path (beside the secret file) goes into the model's script.
    const { dir, secretsFile } = configRoot({ plugins: { runner: "openai-compatible" }, baseUrl: "http://127.0.0.1:1/v1" });
    const planted = join(dirname(secretsFile), "canary.env");
    // The "agent" tries the planted file every way its tools allow, then reports what it found.
    const s2 = await serve(
      toolCall("Read", { file_path: planted }),
      toolCall("Bash", { command: `cat ${planted}; echo $SF_CANARY` }),
      toolCall("Grep", { pattern: "sf-canary-", path: dirname(planted) }),
      toolCall("Glob", { pattern: "*", path: dirname(planted) }),
      toolCall("Grep", { pattern: "sf-canary-" }),
      final({ found: "", harness_token_visible_to_shell: false, attempts: ["Read refused", "Bash refused", "Grep refused"] }),
    );
    const loaded = await loadConfig(dir);
    loaded.file.openai_compatible = { base_url: s2.baseUrl, models: MODELS };
    const report = await runCanary(loaded);
    expect(report).toMatchObject({ passed: true, agent_found_canary: false, agent_status: "completed" });
    expect(s2.requests).toHaveLength(6);
    const results = toolMessages(s2, 5);
    expect(results.slice(0, 4).every((r) => r.startsWith("error: "))).toBe(true);
    expect(results[1]).toBe(`error: ${BASH_REFUSAL}`);
    for (const r of s2.requests) expect(r.body).not.toMatch(/sf-canary-[0-9a-f]{24}/);
  });
});
