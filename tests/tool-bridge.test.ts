import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FORBIDDEN_ENV, Read } from "../src/core/tools/index.js";
import type { Run, RunId, WorkItemId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ClaudeCodeRunner, buildAgentEnv, buildClaudeArgs } from "../src/impl/runner/claude-code-runner.js";
import {
  BRIDGE_SERVER, EGRESS_BLOCKED, LEASE_LOST, NOT_GRANTED, RESULT_CAP_BYTES, RESULT_DIR, RESULT_PREVIEW_BYTES, ToolGate, answerBridgeRequest, bridgeMcpConfig, bridgeScript, harnessToolName,
  packToolHarnessName, startBridgeHost,
} from "../src/impl/runner/tool-bridge.js";
import { startPackMcpServer } from "../src/impl/runner/pack-mcp-client.js";
import { mcpHandler, mcpToolName, serveMcp, socketSender } from "../src/impl/runner/tool-bridge-mcp.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, Sandbox } from "../src/interfaces/sandbox.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import {
  FakeAuth, FakeBroker, FakeNoteBroker, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, prompts, silent,
  triageSpec,
} from "./helpers/fakes.js";
import { ScriptedLLM, type ScriptStep, ScriptedRunner } from "./helpers/scripted-runner.js";
import { newStore } from "./helpers/store.js";

// #164: granted read-only broker tools reach the agent only through the run's bridge. The worker side (ToolGate)
// checks the grant, the lease and the egress scan; the bridge and the agent hold no credential.

/** A token-shaped value the pattern scanner flags (rule github_token). */
const TOKEN_LIKE = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const GITHUB_TOKEN_VALUE = "gh-real-token-value-0f3a";
const OAUTH_VALUE = "oauth-harness-value-77c1";

const GRANTED: FactoryConfig = { ...config, tool_grants: { triage: ["test.read_note"] } };

/** Whether this host lets a test listen on a Unix socket (some sandboxes refuse local binding). */
const canListen = await new Promise<boolean>((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), "sf-listen-"));
  const server = createServer();
  const done = (ok: boolean) => {
    rmSync(dir, { recursive: true, force: true });
    resolve(ok);
  };
  server.once("error", () => done(false));
  server.listen(join(dir, "s"), () => server.close(() => done(true)));
});

/** One issue through triage with a scripted triage agent that may call granted broker tools. */
async function triageWith(steps: ScriptStep[], notes: Record<string, string>, cfg: FactoryConfig = GRANTED) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const broker = new FakeNoteBroker(notes, store);
  const llm = new ScriptedLLM(steps);
  const sandbox = new FakeSandbox();
  const runner = new ScriptedRunner(sandbox, llm, { broker, scanner: cleanScanner });
  const storage = new MemoryStorage();
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage, clock, config: cfg, prompts, log: silent,
    scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(3), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  while (await worker.tick()) await controller.tickRuns();
  const item = (await store.getWorkItemBySource("github_issue", issueRef(3).id))!;
  const run = (await store.listRuns(item.id)).find((r) => r.kind === "triage")!;
  const stored = storage.data.get(`transcripts/${item.id}/${run.id}.json`);
  const transcript = stored ? new TextDecoder().decode(stored) : null;
  return { store, item, run, broker, llm, transcript };
}

function gateSpec(over: Partial<AgentRunSpec> = {}): Pick<AgentRunSpec, "run_id" | "work_item_id" | "lease_token" | "tool_grants" | "signal"> {
  return {
    run_id: "run_g" as RunId,
    work_item_id: "wi_g" as WorkItemId,
    lease_token: 7,
    tool_grants: ["test.read_note"],
    signal: new AbortController().signal,
    ...over,
  };
}

describe("a granted tool, end to end through the worker", () => {
  it("a scripted triage agent calls test.read_note through the broker with the run's context; the result is in the transcript", async () => {
    const { run, item, broker, llm, transcript } = await triageWith(
      [{ tool: "test.read_note", input: { key: "a" } }, { final: triageSpec }],
      { a: "the note text 51e0" },
    );
    expect(run.outcome?.status).toBe("succeeded");
    expect(broker.calls).toHaveLength(1);
    const call = broker.calls[0]!;
    expect(call.name).toBe("test.read_note");
    expect(call.ctx.run_id).toBe(run.id);
    expect(call.ctx.work_item_id).toBe(item.id);
    expect(typeof call.ctx.lease_token).toBe("number");
    // The broker fences on the store's lease, as the GitHub broker does: the tool ran, so the token was the run's.
    expect(broker.ran).toEqual([{ name: "test.read_note", args: { key: "a" } }]);
    expect(llm.observations[0]?.result).toEqual({ ok: true, content: JSON.stringify({ key: "a", note: "the note text 51e0" }) });
    expect(transcript).toContain("the note text 51e0");
  });

  it("withholds a result holding a secret pattern: the agent gets an error and the transcript never has the content", async () => {
    const { run, broker, llm, transcript } = await triageWith(
      [{ tool: "test.read_note", input: { key: "leak" } }, { final: triageSpec }],
      { leak: `here: ${TOKEN_LIKE}` },
    );
    expect(broker.ran).toHaveLength(1);
    const seen = llm.observations[0]?.result;
    expect(seen?.ok).toBe(false);
    if (seen?.ok !== false) throw new Error("expected an error result");
    expect(seen.error).toContain(EGRESS_BLOCKED);
    expect(JSON.stringify(llm.observations)).not.toContain(TOKEN_LIKE);
    expect(run.outcome?.status).toBe("succeeded");
    expect(transcript).not.toBeNull();
    expect(transcript).toContain(EGRESS_BLOCKED);
    expect(transcript).not.toContain(TOKEN_LIKE);
  });

  it("refuses a tool the run was not granted, and the broker is not called", async () => {
    const { broker, llm } = await triageWith(
      [{ tool: "test.write_note", input: {} }, { tool: "github.push_branch", input: {} }, { final: triageSpec }],
      {},
    );
    expect(broker.calls).toEqual([]);
    for (const o of llm.observations) {
      expect(o.result.ok).toBe(false);
      if (o.result.ok) continue;
      expect(o.result.error).toContain(NOT_GRANTED);
    }
  });
});

describe("ToolGate (the worker side of the bridge)", () => {
  it("lists only granted, read-only tools", () => {
    const broker = new FakeNoteBroker();
    expect(new ToolGate({ broker, scanner: cleanScanner }, gateSpec()).list().map((t) => t.name)).toEqual(["test.read_note"]);
    // A non-read-only tool stays hidden and refused even if a grant list somehow names it.
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec({ tool_grants: ["test.read_note", "test.write_note"] }));
    expect(gate.list().map((t) => t.name)).toEqual(["test.read_note"]);
  });

  it("refuses a name outside the grant list without calling the broker", async () => {
    const broker = new FakeNoteBroker({ a: "x" });
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec());
    for (const name of ["test.write_note", "github.push_branch", "nope", 42]) {
      const r = await gate.call(name, {});
      expect(r).toMatchObject({ ok: false, error_code: NOT_GRANTED });
    }
    const hidden = new ToolGate({ broker, scanner: cleanScanner }, gateSpec({ tool_grants: ["test.write_note"] }));
    expect(await hidden.call("test.write_note", {})).toMatchObject({ ok: false, error_code: NOT_GRANTED });
    expect(broker.calls).toEqual([]);
  });

  it("returns lease_lost when the worker aborted the run for a lost lease; the broker and the tool do not run", async () => {
    const broker = new FakeNoteBroker({ a: "x" });
    const lease = new AbortController();
    lease.abort(new Error("lease_lost"));
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec({ signal: lease.signal }));
    expect(await gate.call("test.read_note", { key: "a" })).toMatchObject({ ok: false, error_code: LEASE_LOST });
    expect(broker.calls).toEqual([]);
    expect(broker.ran).toEqual([]);
  });

  it("returns the broker's lease_lost when the store's lease token moved on; the tool's own code does not run", async () => {
    const run = { id: "run_g", work_item_id: "wi_g", status: "running", lease: { token: 8 } } as unknown as Run;
    const broker = new FakeNoteBroker({ a: "x" }, { getRun: async () => run });
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec({ lease_token: 7 }));
    expect(await gate.call("test.read_note", { key: "a" })).toMatchObject({ ok: false, error_code: LEASE_LOST });
    expect(broker.calls).toHaveLength(1);
    expect(broker.ran).toEqual([]);
  });

  it("passes the run's context to the broker and scans the result", async () => {
    const broker = new FakeNoteBroker({ a: "fine", b: TOKEN_LIKE });
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec());
    expect(await gate.call("test.read_note", { key: "a" })).toEqual({ ok: true, content: { key: "a", note: "fine" } });
    expect(broker.calls[0]?.ctx).toEqual({ run_id: "run_g", work_item_id: "wi_g", lease_token: 7 });
    const blocked = await gate.call("test.read_note", { key: "b" });
    expect(blocked).toMatchObject({ ok: false, error_code: EGRESS_BLOCKED });
    expect(JSON.stringify(blocked)).not.toContain(TOKEN_LIKE);
  });

  it("answers a direct socket request (not from the bridge) through the same gate", async () => {
    const broker = new FakeNoteBroker({ a: "x" });
    const gate = new ToolGate({ broker, scanner: cleanScanner }, gateSpec());
    expect(await answerBridgeRequest(gate, { op: "call", name: "test.write_note", args: {} })).toMatchObject({ result: { ok: false, error_code: NOT_GRANTED } });
    expect(await answerBridgeRequest(gate, { op: "call", name: "github.open_pr", args: {} })).toMatchObject({ result: { ok: false, error_code: NOT_GRANTED } });
    expect(await answerBridgeRequest(gate, { op: "exec", cmd: "env" })).toEqual({ error: "unknown request" });
    expect(await answerBridgeRequest(gate, null)).toEqual({ error: "unknown request" });
    expect(broker.calls).toEqual([]);
    expect(await answerBridgeRequest(gate, { op: "list" })).toEqual({
      tools: [{ name: "test.read_note", description: "Read a note by key.", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
    });
  });
});

describe("the bridge's MCP side", () => {
  const gateFor = (broker: FakeNoteBroker) => new ToolGate({ broker, scanner: cleanScanner }, gateSpec());

  it("lists the granted tools under MCP-safe names and maps calls back to broker names", async () => {
    const broker = new FakeNoteBroker({ a: "note" });
    const gate = gateFor(broker);
    const mcp = mcpHandler((req) => answerBridgeRequest(gate, req));
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect(await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list).toMatchObject({ result: { tools: [{ name: "test_read_note", description: "Read a note by key." }] } });
    const call = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "test_read_note", arguments: { key: "a" } } });
    expect(call).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify({ key: "a", note: "note" }) }] } });
    expect(broker.calls.map((c) => c.name)).toEqual(["test.read_note"]);
  });

  it("forwards an unknown name unchanged and returns the worker side's refusal as an error result", async () => {
    const broker = new FakeNoteBroker();
    const gate = gateFor(broker);
    const mcp = mcpHandler((req) => answerBridgeRequest(gate, req));
    const call = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test_write_note", arguments: {} } });
    expect(call).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining(NOT_GRANTED) }] } });
    expect(broker.calls).toEqual([]);
  });

  it("maps names the way the harness allows them", () => {
    expect(mcpToolName("test.read_note")).toBe("test_read_note");
    expect(harnessToolName("forge.preflight")).toBe(`mcp__${BRIDGE_SERVER}__forge_preflight`);
  });

  it.skipIf(!canListen)("round-trips over a real socket; a raw request naming another tool is refused", async () => {
    const broker = new FakeNoteBroker({ a: "over the socket" });
    const host = await startBridgeHost(gateFor(broker));
    try {
      const send = socketSender(host.socket);
      expect(await send({ op: "call", name: "test.write_note", args: {} })).toMatchObject({ result: { ok: false, error_code: NOT_GRANTED } });
      expect(broker.calls).toEqual([]);
      const input = new PassThrough();
      const output = new PassThrough();
      const served = serveMcp(input, output, send);
      input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test_read_note", arguments: { key: "a" } } })}\n`);
      await served;
      const reply = JSON.parse(String(output.read())) as { result: { content: { text: string }[] } };
      expect(reply.result.content[0]?.text).toContain("over the socket");
    } finally {
      await host.close();
    }
  });
});

/** A SecretStore with a GitHub token and the harness credential, for checking neither leaks into the bridge. */
class TwoSecrets implements SecretStore {
  private readonly values: Record<string, string> = { GITHUB_TOKEN: GITHUB_TOKEN_VALUE, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_VALUE };
  async get(name: SecretName): Promise<Secret | null> {
    const v = this.values[name];
    return v === undefined ? null : ({ reveal: () => v } as Secret);
  }
  async valuesForScan(): Promise<string[]> {
    return Object.values(this.values);
  }
}

describe("the output cap on granted tool results", () => {
  /** A note whose JSON result is over the cap, ending in a marker that only the full text holds. */
  const BIG = `${"n".repeat(RESULT_CAP_BYTES)}TAIL-ONLY-IN-FILE`;

  it("caps a granted tool that is not a pack tool: a result over the cap goes to a file in the run folder; the agent gets its path and first 2 KB, never the full text", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "sf-cap-"));
    const gate = new ToolGate({ broker: new FakeNoteBroker({ big: BIG }), scanner: cleanScanner }, { ...gateSpec(), sandbox: { workdir } });
    const r = await gate.call("test.read_note", { key: "big" });
    if (!r.ok) throw new Error("expected a result");
    const full = JSON.stringify({ key: "big", note: BIG });
    const content = r.content as { truncated: boolean; path: string; bytes: number; preview: string };
    expect(content).toMatchObject({ truncated: true, bytes: full.length, preview: full.slice(0, RESULT_PREVIEW_BYTES) });
    expect(content.path.startsWith(join(workdir, RESULT_DIR))).toBe(true);
    expect(readFileSync(content.path, "utf8")).toBe(full);
    // What goes back to the agent is the preview and the path, not the full text.
    const sent = JSON.stringify(r);
    expect(sent).not.toContain("TAIL-ONLY-IN-FILE");
    expect(sent.length).toBeLessThan(RESULT_PREVIEW_BYTES + 1024);
    // The folder ignores itself, so a capped result is never committed with the run's change.
    expect(readFileSync(join(workdir, RESULT_DIR, ".gitignore"), "utf8")).toBe("*\n");
    // A second capped call gets its own file.
    const again = await gate.call("test.read_note", { key: "big" });
    expect((again as { content: { path: string } }).content.path).not.toBe(content.path);
    expect(readdirSync(join(workdir, RESULT_DIR)).filter((f) => f.endsWith(".txt"))).toHaveLength(2);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("cuts the 2 KB preview on a character boundary when the boundary falls inside a multibyte character", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "sf-cap-"));
    const head = `{"key":"mb","note":"`;
    // ASCII up to one byte before the preview's end, then 3-byte characters: the first one spans the boundary.
    const note = `${"a".repeat(RESULT_PREVIEW_BYTES - head.length - 1)}${"€".repeat(RESULT_CAP_BYTES)}`;
    const gate = new ToolGate({ broker: new FakeNoteBroker({ mb: note }), scanner: cleanScanner }, { ...gateSpec(), sandbox: { workdir } });
    const r = await gate.call("test.read_note", { key: "mb" });
    const { preview, path } = (r as { content: { preview: string; path: string } }).content;
    expect(preview).not.toContain("\uFFFD");
    expect(Buffer.byteLength(preview, "utf8")).toBe(RESULT_PREVIEW_BYTES - 1);
    expect(preview).toBe(JSON.stringify({ key: "mb", note }).slice(0, RESULT_PREVIEW_BYTES - 1));
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ key: "mb", note }));
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns a result at or under the cap unchanged and writes no file", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "sf-cap-"));
    const gate = new ToolGate({ broker: new FakeNoteBroker({ a: "small" }), scanner: cleanScanner }, { ...gateSpec(), sandbox: { workdir } });
    expect(await gate.call("test.read_note", { key: "a" })).toEqual({ ok: true, content: { key: "a", note: "small" } });
    expect(existsSync(join(workdir, RESULT_DIR))).toBe(false);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("with no run folder, a result over the cap is cut to its preview with no path", async () => {
    const gate = new ToolGate({ broker: new FakeNoteBroker({ big: BIG }), scanner: cleanScanner }, gateSpec());
    const r = await gate.call("test.read_note", { key: "big" });
    expect(r).toMatchObject({ ok: true, content: { truncated: true, path: null } });
    expect(JSON.stringify(r)).not.toContain("TAIL-ONLY-IN-FILE");
  });

  it("scans the full result before the cap: a flagged result is withheld and no file is written", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "sf-cap-"));
    const flagging = { scan: async () => ({ clean: false, findings: [{ rule: "test_rule" }] }) } as unknown as typeof cleanScanner;
    const gate = new ToolGate({ broker: new FakeNoteBroker({ big: BIG }), scanner: flagging }, { ...gateSpec(), sandbox: { workdir } });
    expect(await gate.call("test.read_note", { key: "big" })).toMatchObject({ ok: false, error_code: EGRESS_BLOCKED });
    expect(existsSync(join(workdir, RESULT_DIR))).toBe(false);
    rmSync(workdir, { recursive: true, force: true });
  });
});

function runSpec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    run_id: "run_b" as RunId,
    work_item_id: "wi_b" as WorkItemId,
    role: "triage",
    sandbox: { id: "s", workdir: "/w" },
    system_prompt: "s",
    prompt: "p",
    tools: [Read],
    tool_grants: ["test.read_note"],
    lease_token: 1,
    env_allowlist: { SF_WORKER_INDEX: "0" },
    deny_paths: [],
    writable_paths: [],
    model_class: "cheap",
    timeout_ms: 30_000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A ClaudeCodeRunner on a sandbox that records the argv and env of the `claude` call instead of running it. */
function recordingRunner(tools?: { broker: FakeNoteBroker }) {
  const seen: { cmd: readonly string[]; env: Record<string, string> }[] = [];
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (_h, cmd, opts: ExecOptions): Promise<ExecResult> => {
      seen.push({ cmd, env: { ...(opts.env ?? {}) } });
      const result = { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } };
      return { exit_code: 0, signal: null, stdout: `${JSON.stringify(result)}\n`, stderr: "", timed_out: false };
    },
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = mkdtempSync(join(tmpdir(), "sf-bridge-homes-"));
  const runner = new ClaudeCodeRunner({
    sandbox,
    secrets: new TwoSecrets(),
    claudeConfigDir: join(homes, "cfg"),
    homesDir: homes,
    models: { cheap: "haiku", standard: "sonnet", strong: "opus" },
    ...(tools ? { tools: { broker: tools.broker, scanner: cleanScanner } } : {}),
  });
  return { runner, seen };
}

describe("no credential in the agent's environment or the bridge's configuration", () => {
  it("the bridge's MCP config holds only node, the bridge script and the socket path, with an empty env", () => {
    const cfg = bridgeMcpConfig("/tmp/sf-tools-x/s");
    expect(cfg).toEqual({
      mcpServers: { [BRIDGE_SERVER]: { type: "stdio", command: process.execPath, args: [bridgeScript(), "/tmp/sf-tools-x/s"], env: {} } },
    });
    const text = JSON.stringify(cfg);
    for (const v of [GITHUB_TOKEN_VALUE, OAUTH_VALUE]) expect(text).not.toContain(v);
  });

  it("a run with grants gets the same agent env as one without: nothing but the harness credential is secret", () => {
    const cred = { name: "CLAUDE_CODE_OAUTH_TOKEN", value: OAUTH_VALUE } as const;
    const paths = { home: "/h", claudeConfigDir: "/c", path: "/usr/bin" };
    const withGrants = buildAgentEnv(runSpec(), cred, paths);
    expect(withGrants).toEqual(buildAgentEnv(runSpec({ tool_grants: [] }), cred, paths));
    const secretKeys = Object.keys(withGrants).filter((k) => FORBIDDEN_ENV.test(k));
    expect(secretKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(Object.values(withGrants)).not.toContain(GITHUB_TOKEN_VALUE);
  });

  it("the claude argv adds only the bridge's MCP server and the granted tool names", () => {
    const bridge = { mcpConfig: bridgeMcpConfig("/tmp/sf-tools-x/s"), tools: ["test.read_note"] };
    const args = buildClaudeArgs(runSpec(), "haiku", "claude", bridge);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(JSON.stringify(bridge.mcpConfig));
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(`Read,${harnessToolName("test.read_note")}`);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    for (const v of [GITHUB_TOKEN_VALUE, OAUTH_VALUE]) expect(args.join(" ")).not.toContain(v);
    // Without grants nothing changes: no MCP server at all.
    const plain = buildClaudeArgs(runSpec({ tool_grants: [] }), "haiku");
    expect(plain).not.toContain("--mcp-config");
    expect(plain[plain.indexOf("--allowedTools") + 1]).toBe("Read");
  });

  it.skipIf(!canListen)("a real run's claude call: env and MCP config hold no broker credential", async () => {
    const { runner, seen } = recordingRunner({ broker: new FakeNoteBroker() });
    expect(runner.exposes_tools).toBe(true);
    const res = await runner.run(runSpec());
    expect(res.status).toBe("completed");
    const { cmd, env } = seen[0]!;
    const mcp = cmd[cmd.indexOf("--mcp-config") + 1]!;
    expect(JSON.parse(mcp)).toMatchObject({ mcpServers: { [BRIDGE_SERVER]: { env: {} } } });
    expect(mcp).not.toContain(GITHUB_TOKEN_VALUE);
    expect(mcp).not.toContain(OAUTH_VALUE);
    expect(Object.values(env)).not.toContain(GITHUB_TOKEN_VALUE);
    expect(Object.keys(env).filter((k) => FORBIDDEN_ENV.test(k))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
});

describe("a runner that cannot expose tools refuses grants", () => {
  it("ClaudeCodeRunner without a broker fails the run with an error naming the granted tools, and never starts claude", async () => {
    const { runner, seen } = recordingRunner();
    expect(runner.exposes_tools).toBe(false);
    const res = await runner.run(runSpec({ tool_grants: ["test.read_note", "forge.preflight"] }));
    expect(res.status).toBe("failed");
    expect(res.error).toContain("test.read_note");
    expect(res.error).toContain("forge.preflight");
    expect(seen).toEqual([]);
  });

  it("ClaudeCodeRunner without grants runs as before, with no bridge", async () => {
    const { runner, seen } = recordingRunner();
    expect((await runner.run(runSpec({ tool_grants: [] }))).status).toBe("completed");
    expect(seen[0]?.cmd).not.toContain("--mcp-config");
  });

  it("ScriptedRunner without a broker refuses too", async () => {
    const runner = new ScriptedRunner(new FakeSandbox(), new ScriptedLLM([{ final: {} }]));
    expect(runner.exposes_tools).toBe(false);
    const res = await runner.run(runSpec());
    expect(res.status).toBe("failed");
    expect(res.error).toContain("test.read_note");
  });
});

// #596: an approved, granted pack MCP server with no credential is started by the runner from its descriptor's
// command and args with an empty env; the agent reaches it only through its own bridge entry, so every result passes
// the gate's egress scan and output cap.
describe("pack MCP servers", () => {
  /** A planted credential value: in the worker's own env and nowhere the agent or the server can read it. */
  const PLANTED = "planted-credential-value-5d1e";
  /** A tiny stdio MCP server: records its argv, env and pid to its first argument, then serves one tool, `search`. */
  const SERVER_SCRIPT = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(2), env: process.env, pid: process.pid }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  if (m.method === "initialize") reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") reply(m.id, { tools: [{ name: "search", description: "Searches the docs.", inputSchema: { type: "object" } }] });
  else if (m.method === "tools/call") {
    const q = m.params.arguments.q;
    const text = q === "flag" ? "FLAG-ME" : q === "big" ? "x".repeat(${RESULT_CAP_BYTES}) + "TAIL-ONLY-IN-FILE" : "found " + q;
    reply(m.id, { content: [{ type: "text", text }] });
  }
}
`;
  function serverFixture() {
    const dir = mkdtempSync(join(tmpdir(), "sf-pack-mcp-"));
    const script = join(dir, "server.mjs");
    writeFileSync(script, SERVER_SCRIPT);
    const record = join(dir, "record.json");
    const server = { name: "docs-search", command: process.execPath, args: [script, record] };
    const recorded = () => JSON.parse(readFileSync(record, "utf8")) as { args: string[]; env: Record<string, string>; pid: number };
    return { dir, server, record, recorded };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A scanner that flags the text FLAG-ME. */
  const flagging = {
    scan: async (channel: string, content: string) => (content.includes("FLAG-ME") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }),
  } as unknown as typeof cleanScanner;

  it.skipIf(!canListen)("is started from its descriptor with an empty env, gets its own bridge entry in --mcp-config, and the argv allows its tools; no credential in the config, argv, agent env or server env", async () => {
    const f = serverFixture();
    process.env.SF_TEST_PLANTED_TOKEN = PLANTED;
    try {
      const { runner, seen } = recordingRunner({ broker: new FakeNoteBroker() });
      expect(runner.runs_mcp_servers).toBe(true);
      const res = await runner.run(runSpec({ tool_grants: [], mcp_servers: [f.server] }));
      expect(res.status).toBe("completed");
      const { cmd, env } = seen[0]!;
      const mcp = cmd[cmd.indexOf("--mcp-config") + 1]!;
      expect(JSON.parse(mcp)).toEqual({
        mcpServers: { "pack_docs-search": { type: "stdio", command: process.execPath, args: [bridgeScript(), expect.any(String), "docs-search"], env: {} } },
      });
      expect(cmd[cmd.indexOf("--allowedTools") + 1]).toBe(`Read,${packToolHarnessName("docs-search", "search")}`);
      expect(packToolHarnessName("docs-search", "search")).toBe("mcp__pack_docs-search__search");
      // The worker started the server from the descriptor, with an empty env, and stopped it when the run ended.
      const rec = f.recorded();
      expect(rec.args).toEqual([f.record]);
      // macOS adds its own __CF_USER_TEXT_ENCODING to every process; nothing else is there.
      expect(Object.keys(rec.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
      expect(alive(rec.pid)).toBe(false);
      const texts = [cmd.join("\n"), JSON.stringify(env), readFileSync(f.record, "utf8")];
      for (const text of texts) for (const v of [PLANTED, GITHUB_TOKEN_VALUE]) expect(text).not.toContain(v);
      expect(Object.keys(env).filter((k) => FORBIDDEN_ENV.test(k))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    } finally {
      delete process.env.SF_TEST_PLANTED_TOKEN;
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("each result passes the egress scan and the output cap: a flagged result is withheld and an oversize one is capped", async () => {
    const f = serverFixture();
    const workdir = mkdtempSync(join(tmpdir(), "sf-cap-"));
    const server = await startPackMcpServer(f.server, { cwd: f.dir });
    try {
      const gate = new ToolGate({ broker: new FakeNoteBroker(), scanner: flagging }, { ...gateSpec({ tool_grants: [] }), sandbox: { workdir } }, [server]);
      expect(await answerBridgeRequest(gate, { op: "list", server: "docs-search" })).toEqual({
        tools: [{ name: "search", description: "Searches the docs.", input_schema: { type: "object" } }],
      });
      // The pack server's entry lists only its own tools; the broker entry lists none of them.
      expect(await answerBridgeRequest(gate, { op: "list" })).toEqual({ tools: [] });
      expect(await gate.callServer("docs-search", "search", { q: "hello" })).toEqual({ ok: true, content: "found hello" });
      const flagged = await gate.callServer("docs-search", "search", { q: "flag" });
      expect(flagged).toMatchObject({ ok: false, error_code: EGRESS_BLOCKED });
      expect(JSON.stringify(flagged)).not.toContain("FLAG-ME");
      const big = await gate.callServer("docs-search", "search", { q: "big" });
      const content = (big as { content: { truncated: boolean; path: string; preview: string } }).content;
      expect(content).toMatchObject({ truncated: true });
      expect(content.path.startsWith(join(workdir, RESULT_DIR))).toBe(true);
      expect(readFileSync(content.path, "utf8")).toContain("TAIL-ONLY-IN-FILE");
      expect(JSON.stringify(big)).not.toContain("TAIL-ONLY-IN-FILE");
      // A tool or server the run was not given is refused without a call.
      expect(await gate.callServer("docs-search", "write", {})).toMatchObject({ ok: false, error_code: NOT_GRANTED });
      expect(await gate.callServer("other", "search", {})).toMatchObject({ ok: false, error_code: NOT_GRANTED });
      // A lost lease stops the call before the server.
      const lost = new AbortController();
      lost.abort();
      const fenced = new ToolGate({ broker: new FakeNoteBroker(), scanner: flagging }, gateSpec({ tool_grants: [], signal: lost.signal }), [server]);
      expect(await fenced.callServer("docs-search", "search", { q: "x" })).toMatchObject({ ok: false, error_code: LEASE_LOST });
    } finally {
      await server.close();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it.skipIf(!canListen)("the bridge entry of a pack server forwards the agent's MCP calls to the gate under the server's name", async () => {
    const f = serverFixture();
    const server = await startPackMcpServer(f.server, { cwd: f.dir });
    const host = await startBridgeHost(new ToolGate({ broker: new FakeNoteBroker(), scanner: flagging }, gateSpec({ tool_grants: [] }), [server]));
    try {
      const handle = mcpHandler(socketSender(host.socket, "docs-search"));
      expect(await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ result: { tools: [{ name: "search" }] } });
      expect(await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { q: "hi" } } })).toEqual({
        jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "found hi" }] },
      });
      const flagged = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { q: "flag" } } });
      expect(flagged).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(flagged)).not.toContain("FLAG-ME");
    } finally {
      await host.close();
      await server.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("ClaudeCodeRunner without a broker fails a run granted a pack MCP server, and starts neither claude nor the server", async () => {
    const f = serverFixture();
    const { runner, seen } = recordingRunner();
    expect(runner.runs_mcp_servers).toBe(false);
    const res = await runner.run(runSpec({ tool_grants: [], mcp_servers: [f.server] }));
    expect(res.status).toBe("failed");
    expect(res.error).toContain("docs-search");
    expect(seen).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("a server that does not start fails the run without claude, naming the server only", async () => {
    const { runner, seen } = recordingRunner({ broker: new FakeNoteBroker() });
    const res = await runner.run(runSpec({ tool_grants: [], mcp_servers: [{ name: "gone", command: join(tmpdir(), "sf-no-such-command"), args: [] }] }));
    expect(res).toMatchObject({ status: "failed", error: "pack MCP server gone did not start" });
    expect(seen).toEqual([]);
  });
});
