// The worker's side of a pack MCP server (design 11-packs, issue #596): the runner starts each approved stdio
// server the run is granted, from its descriptor's `command` and `args` with an empty env, and speaks MCP to it
// (newline-delimited JSON-RPC on its stdin and stdout). The agent never talks to the server: its calls come through
// the run's bridge to ToolGate, which calls the server here and scans and caps each result before the agent sees it.
// The server's stderr is dropped unread, so nothing it prints reaches a log.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PackMcpServer } from "../../interfaces/agent-runner.js";
import type { ToolResult } from "../../interfaces/tool-broker.js";
import type { HostTool } from "./tool-bridge-mcp.js";

/** How long the server may take to answer `initialize`, `tools/list` or one call. */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

const PROTOCOL = "2025-06-18";

/** A started pack MCP server: the tools it listed at start, a call, and its stop. */
export interface RunningMcpServer {
  readonly name: string;
  readonly tools: readonly HostTool[];
  call(tool: string, args: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

interface RpcReply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
}

/**
 * Starts `server` in `cwd` with an empty env, then `initialize` and `tools/list` (every page). Throws when it does
 * not start or answer; the process is stopped first.
 */
export async function startPackMcpServer(server: PackMcpServer, opts: { cwd?: string; timeout_ms?: number } = {}): Promise<RunningMcpServer> {
  const timeout = opts.timeout_ms ?? MCP_REQUEST_TIMEOUT_MS;
  const child = spawn(server.command, [...server.args], { cwd: opts.cwd, env: {}, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (r: RpcReply) => void>();
  let ended: Error | null = null;
  const end = (err: Error) => {
    ended ??= err;
    for (const resolve of waiting.values()) resolve({ error: { message: ended.message } });
    waiting.clear();
  };
  child.on("error", (err) => end(err));
  child.on("exit", () => end(new Error("the server exited")));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let msg: RpcReply;
    try {
      msg = JSON.parse(line) as RpcReply;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });

  let next = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (ended) return Promise.reject(ended);
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        if (r.result && typeof r.result === "object") resolve(r.result);
        else reject(new Error(typeof r.error?.message === "string" ? r.error.message : `${method} failed`));
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const close = async () => {
    // Never spawned (no pid), or already gone: nothing to stop.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(kill);
  };

  try {
    await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "software-factory", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools: HostTool[] = [];
    let cursor: unknown;
    do {
      const page = await request("tools/list", typeof cursor === "string" ? { cursor } : {});
      for (const t of Array.isArray(page.tools) ? (page.tools as Record<string, unknown>[]) : []) {
        if (typeof t.name !== "string") continue;
        const schema = t.inputSchema;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          input_schema: schema && typeof schema === "object" ? (schema as Record<string, unknown>) : { type: "object" },
        });
      }
      cursor = page.nextCursor;
    } while (typeof cursor === "string");
    return { name: server.name, tools, call: (tool, args) => callTool(request, tool, args), close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** One `tools/call`: its text content joined (or the content list when any item is not text), or its error. */
async function callTool(
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const r = await request("tools/call", { name, arguments: args ?? {} });
  const items = Array.isArray(r.content) ? (r.content as { type?: unknown; text?: unknown }[]) : [];
  const text = items.every((c) => c.type === "text" && typeof c.text === "string") ? items.map((c) => c.text).join("\n") : null;
  if (r.isError === true) return { ok: false, error_code: "tool_error", message: text ?? JSON.stringify(items) };
  return { ok: true, content: text ?? items };
}
