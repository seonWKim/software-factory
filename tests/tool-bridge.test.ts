import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_ENV } from "../src/core/tools/index.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { READ_TOOLS } from "../src/core/worker.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { BRIDGE_SOCKET_ENV, BRIDGE_TOOLS_ENV, serveMcp, socketForwarder } from "../src/impl/runner/tool-bridge-main.js";
import { answerLine, bridgeTools, openToolSocket } from "../src/impl/runner/tool-bridge.js";
import { type GatewaySpec, grantedTools } from "../src/impl/runner/tool-gateway.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import { FakeBroker, MemoryStorage, cleanScanner, pipeline, triageSpec } from "./helpers/fakes.js";
import { ScriptedLLM, ScriptedRunner } from "./helpers/scripted-runner.js";

// Granted broker tools reach the agent through a bridge (issue #164). Every call ends on the worker side: the
// grant check, the broker's call with the run's own context (lease fence), and the egress scan of the result.

const NOTE = "the note says 42";
/** Token-shaped: the pattern scanner's github_token rule flags it. */
const LEAKY = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const HARNESS_VALUE = "oauth-harness-value-7f3a";
const BROKER_SECRET = "broker-only-credential-9c1e";

/** The run's context as the worker would give it. */
function gatewaySpec(over: Partial<GatewaySpec> = {}): GatewaySpec {
  return {
    run_id: "run_bridge" as RunId,
    work_item_id: "wi_bridge" as WorkItemId,
    lease_token: 7,
    tool_grants: ["test.read_note"],
    signal: new AbortController().signal,
    ...over,
  };
}

/** A store that knows one running run, holding lease `token`. */
function storeWithLease(token: number): FactoryStore {
  return {
    getRun: async (id: string) => ({ id, work_item_id: "wi_bridge", status: "running", lease: { token } }),
  } as unknown as FactoryStore;
}

function noteBroker(): FakeBroker {
  const b = new FakeBroker();
  b.notes = { n: NOTE, leaky: `before ${LEAKY} after` };
  return b;
}

/** Writes one JSON line to `socketPath` and reads one line back: a client that is not the bridge. */
async function rawCall(socketPath: string, msg: unknown): Promise<{ id: unknown; result: { ok: boolean; error_code?: string; content?: unknown } }> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socketPath);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        c.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    c.on("error", reject);
    c.write(`${JSON.stringify(msg)}\n`);
  });
}

/** Runs the MCP bridge over in-memory streams and returns its answers, one per request, by id. */
async function mcp(requests: unknown[], forward: Parameters<typeof serveMcp>[3], tools: Parameters<typeof serveMcp>[2]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (d: Buffer) => (text += d.toString("utf8")));
  const served = serveMcp(input, output, tools, forward);
  for (const r of requests) input.write(`${JSON.stringify(r)}\n`);
  input.end();
  await served;
  const answers = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: unknown; result?: any; error?: any });
  return new Map(answers.map((a) => [a.id, a]));
}

describe("a scripted triage agent calls a granted read-only tool through the worker", () => {
  const grants: Partial<FactoryConfig> = { tool_grants: { triage: ["test.read_note"] } };

  async function triageWith(note: string) {
    const broker = noteBroker();
    const storage = new MemoryStorage();
    const llm = new ScriptedLLM([{ tool: "test.read_note", input: { name: note } }, { final: triageSpec }]);
    let runner!: ScriptedRunner;
    const p = await pipeline({
      config: grants,
      broker,
      storage,
      agentRunner: { run: (s) => runner.run(s), exposes_tools: true },
    });
    broker.store = p.store;
    runner = new ScriptedRunner(p.sandbox, llm, { broker, scanner: cleanScanner });
    const item = await p.submit();
    await p.w1.tick();
    const run = (await p.runs(item, "triage"))[0]!;
    const transcripts = [...storage.data.entries()].filter(([k]) => k.startsWith(`transcripts/${item.id}/`));
    return { broker, llm, item, run, transcript: transcripts.map(([, v]) => new TextDecoder().decode(v)).join("\n") };
  }

  it("goes through the broker's call with the run's id, item and lease token; its result is in the transcript", async () => {
    const { broker, llm, item, run, transcript } = await triageWith("n");
    expect(run.status).toBe("succeeded");
    expect(broker.reads).toHaveLength(1);
    expect(broker.reads[0]!.ctx).toEqual({ run_id: run.id, work_item_id: item.id, lease_token: run.lease?.token ?? expect.any(Number) });
    expect(llm.observations[0]!.result).toEqual({ ok: true, content: JSON.stringify({ note: NOTE }) });
    expect(transcript).toContain(NOTE);
  });

  it("a result with a secret pattern is withheld: the agent gets an error, the transcript has no content", async () => {
    const { broker, llm, transcript } = await triageWith("leaky");
    expect(broker.reads).toHaveLength(1);
    const seen = llm.observations[0]!.result;
    expect(seen.ok).toBe(false);
    expect(JSON.stringify(seen)).toContain("egress_blocked");
    expect(JSON.stringify(llm.observations)).not.toContain(LEAKY);
    expect(transcript).not.toContain(LEAKY);
    expect(transcript).not.toContain("before");
  });
});

describe("the worker-side gateway", () => {
  it("a run that lost its lease gets lease_lost, and the tool's code does not run", async () => {
    const broker = noteBroker();
    broker.store = storeWithLease(8); // the run's lease moved on: token 8, the run still has 7
    const r = await grantedTools({ broker, scanner: cleanScanner }, gatewaySpec()).call("test.read_note", { name: "n" });
    expect(r).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(broker.reads).toEqual([]);
  });

  it("a stopped run (lease lost, signal aborted) never reaches the broker", async () => {
    const broker = noteBroker();
    const ctl = new AbortController();
    ctl.abort();
    const r = await grantedTools({ broker, scanner: cleanScanner }, gatewaySpec({ signal: ctl.signal })).call("test.read_note", { name: "n" });
    expect(r).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(broker.reads).toEqual([]);
  });

  it("a granted name the broker marks as not read-only is not exposed and not called", async () => {
    const broker = noteBroker();
    const g = grantedTools({ broker, scanner: cleanScanner }, gatewaySpec({ tool_grants: ["github.comment"] }));
    expect(g.tools).toEqual([]);
    expect(await g.call("github.comment", { number: 1, body: "x", marker: "m" })).toMatchObject({ ok: false, error_code: "not_granted" });
    expect(broker.calls).toEqual([]);
  });
});

describe("the run's socket refuses ungranted names, whoever sends them", () => {
  it("each line is answered through the grant check: other names are refused before the broker", async () => {
    const broker = noteBroker();
    const gateway = grantedTools({ broker, scanner: cleanScanner }, gatewaySpec());
    for (const name of ["github.comment", "github.preflight", 42, null]) {
      const out = await answerLine(gateway, JSON.stringify({ id: 9, name, args: {} }));
      expect(out).toEqual({ id: 9, result: expect.objectContaining({ ok: false, error_code: "not_granted" }) });
    }
    expect(await answerLine(gateway, "not json")).toBeNull();
    expect(await answerLine(gateway, "[1]")).toBeNull();
    expect(broker.calls).toEqual([]);
    expect(broker.preflights).toEqual([]);
    expect(broker.reads).toEqual([]);
    expect(await answerLine(gateway, JSON.stringify({ id: 1, name: "test.read_note", args: { name: "n" } }))).toEqual({
      id: 1,
      result: { ok: true, content: { note: NOTE } },
    });
  });

  it("a client that is not the bridge naming another tool is refused; the broker is not called", async () => {
    const broker = noteBroker();
    const sock = await openToolSocket(grantedTools({ broker, scanner: cleanScanner }, gatewaySpec()));
    try {
      for (const name of ["github.comment", "github.push_branch", "github.preflight", "nope"]) {
        const r = await rawCall(sock.path, { id: 1, name, args: { number: 1, body: "x", marker: "m", branch: "factory/x", base_ref: "main" } });
        expect(r.result).toMatchObject({ ok: false, error_code: "not_granted" });
      }
      expect(broker.calls).toEqual([]);
      expect(broker.preflights).toEqual([]);
      expect(broker.reads).toEqual([]);
      // The granted one still works over the same socket.
      expect((await rawCall(sock.path, { id: 2, name: "test.read_note", args: { name: "n" } })).result).toEqual({ ok: true, content: { note: NOTE } });
    } finally {
      await sock.close();
    }
    expect(existsSync(sock.path)).toBe(false);
  });

  it("the MCP bridge (no socket) lists only granted tools and forwards only those", async () => {
    const broker = noteBroker();
    const gateway = grantedTools({ broker, scanner: cleanScanner }, gatewaySpec());
    const names: string[] = [];
    const answers = await mcp(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "github_preflight", arguments: {} } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "test_read_note", arguments: { name: "leaky" } } },
        { jsonrpc: "2.0", id: 4, method: "resources/list" },
      ],
      (name, args) => {
        names.push(name);
        return gateway.call(name, args);
      },
      bridgeTools(gateway.tools),
    );
    expect(answers.get(1)?.result.tools).toEqual([
      { name: "test_read_note", description: "Read a note by name.", inputSchema: expect.objectContaining({ type: "object" }) },
    ]);
    expect(answers.get(2)?.result.isError).toBe(true);
    expect(answers.get(3)?.result.isError).toBe(true);
    expect(answers.get(3)?.result.content[0].text).toContain("egress_blocked");
    expect(JSON.stringify([...answers.values()])).not.toContain(LEAKY);
    expect(answers.get(4)?.error.code).toBe(-32601);
    expect(names).toEqual(["test.read_note"]);
  });

  it("the bridge lists only granted tools, refuses other names itself, and forwards granted calls", async () => {
    const broker = noteBroker();
    const gateway = grantedTools({ broker, scanner: cleanScanner }, gatewaySpec());
    const sock = await openToolSocket(gateway);
    const fwd = socketForwarder(sock.path);
    let forwarded = 0;
    try {
      const answers = await mcp(
        [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "github_comment", arguments: { body: "x" } } },
          { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "test_read_note", arguments: { name: "n" } } },
        ],
        (name, args) => {
          forwarded++;
          return fwd.forward(name, args);
        },
        bridgeTools(gateway.tools),
      );
      expect(answers.get(1)?.result.capabilities).toEqual({ tools: {} });
      expect(answers.get(2)?.result.tools.map((t: { name: string }) => t.name)).toEqual(["test_read_note"]);
      expect(answers.get(3)?.result.isError).toBe(true);
      expect(answers.get(3)?.result.content[0].text).toContain("not_granted");
      expect(answers.get(4)?.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ note: NOTE }) }], isError: false });
      expect(forwarded).toBe(1);
      expect(broker.calls).toEqual([]);
      expect(broker.reads).toHaveLength(1);
    } finally {
      fwd.close();
      await sock.close();
    }
  });
});

describe("the Claude Code runner with granted tools", () => {
  /** Runs the runner once on a fake sandbox; `during` runs while the claude process would (the socket is open). */
  async function runOnce(grants: readonly string[], during?: (args: readonly string[]) => Promise<void>) {
    const broker = noteBroker();
    const seen: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const sandbox = {
      async exec(_h: SandboxHandle, cmd: readonly string[], opts: ExecOptions): Promise<ExecResult> {
        seen.push({ args: cmd, env: opts.env ?? {} });
        await during?.(cmd);
        return { exit_code: 0, signal: null, stdout: `${JSON.stringify({ type: "result", result: "ok" })}\n`, stderr: "", timed_out: false };
      },
    } as unknown as Sandbox;
    const secrets: SecretStore = {
      get: async (n: SecretName) =>
        n === "CLAUDE_CODE_OAUTH_TOKEN" ? { name: n, reveal: () => HARNESS_VALUE, toJSON: () => "[secret]" } : null,
      valuesForScan: async () => [HARNESS_VALUE, BROKER_SECRET],
    };
    const runner = new ClaudeCodeRunner({
      sandbox,
      secrets,
      claudeConfigDir: join(tmpdir(), "sf-bridge-cfg"),
      homesDir: join(tmpdir(), "sf-bridge-homes"),
      models: { cheap: "c", standard: "s", strong: "x" },
      broker,
      scanner: cleanScanner,
    });
    const spec: AgentRunSpec = {
      ...gatewaySpec({ tool_grants: grants }),
      role: "triage",
      sandbox: { id: "sbx", workdir: join(tmpdir(), "sf-bridge-run") },
      system_prompt: "s",
      prompt: "p",
      tools: READ_TOOLS,
      env_allowlist: { LANGUAGE: "en" },
      deny_paths: [],
      writable_paths: [],
      model_class: "cheap",
      timeout_ms: 60_000,
    };
    const res = await runner.run(spec);
    return { res, seen: seen[0]!, broker };
  }

  const flag = (args: readonly string[], name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  it("starts the bridge with only the granted tools; the agent's env and the bridge's config hold no credential", async () => {
    let called: unknown;
    const { res, seen, broker } = await runOnce(["test.read_note"], async (args) => {
      const cfg = JSON.parse(flag(args, "--mcp-config")!) as { mcpServers: Record<string, { env: Record<string, string> }> };
      called = await rawCall(cfg.mcpServers.factory!.env[BRIDGE_SOCKET_ENV]!, { id: 1, name: "test.read_note", args: { name: "n" } });
    });
    expect(res.status).toBe("completed");
    expect(called).toEqual({ id: 1, result: { ok: true, content: { note: NOTE } } });
    expect(broker.reads[0]!.ctx).toEqual({ run_id: "run_bridge", work_item_id: "wi_bridge", lease_token: 7 });

    const config = flag(seen.args, "--mcp-config")!;
    const server = (JSON.parse(config) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers.factory!;
    expect(Object.keys(server.env).sort()).toEqual([BRIDGE_SOCKET_ENV, BRIDGE_TOOLS_ENV].sort());
    expect(JSON.parse(server.env[BRIDGE_TOOLS_ENV]!).map((t: { name: string }) => t.name)).toEqual(["test.read_note"]);
    expect(flag(seen.args, "--tools")).toBe("Read,Glob,Grep");
    expect(flag(seen.args, "--allowedTools")).toBe("Read,Glob,Grep,mcp__factory__test_read_note");
    // No secret value and no credential-shaped name anywhere in the bridge's configuration.
    for (const value of [HARNESS_VALUE, BROKER_SECRET, "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(config).not.toContain(value);
    }
    for (const key of Object.keys(server.env)) expect(key).not.toMatch(FORBIDDEN_ENV);

    // The agent's environment is the same as without grants: only the harness credential, no broker credential.
    const plain = await runOnce([]);
    expect(Object.keys(seen.env).sort()).toEqual(Object.keys(plain.seen.env).sort());
    expect(plain.seen.args).not.toContain("--mcp-config");
    const credentialKeys = Object.keys(seen.env).filter((k) => FORBIDDEN_ENV.test(k));
    expect(credentialKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(JSON.stringify(seen.env)).not.toContain(BROKER_SECRET);
  });

  it("closes the run's socket when the run ends", async () => {
    let path = "";
    await runOnce(["test.read_note"], async (args) => {
      const cfg = JSON.parse(flag(args, "--mcp-config")!) as { mcpServers: Record<string, { env: Record<string, string> }> };
      path = cfg.mcpServers.factory!.env[BRIDGE_SOCKET_ENV]!;
      expect(existsSync(path)).toBe(true);
    });
    expect(existsSync(path)).toBe(false);
  });
});
