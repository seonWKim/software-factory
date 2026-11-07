// The tool bridge (docs/architecture.md §5): a stdio MCP server that the `claude` process starts for a run with
// granted broker tools. It lists only the granted tools and forwards each call, as one JSON line, to the run's
// local socket in the worker process, which checks the grant, calls the broker and scans the result.
//
// It holds no credential and needs none: its whole configuration is the socket path and the tool list
// (SF_TOOL_SOCKET, SF_TOOL_LIST). Self-contained on purpose (node builtins only), so it starts fast and can run
// from source or from dist.

import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

/** One granted tool as the bridge shows it: the MCP name the model sees, and the broker name it forwards. */
export interface BridgeTool {
  /** The broker's name, e.g. "github.preflight". */
  name: string;
  /** The MCP name: the broker name with every character outside [A-Za-z0-9_-] as `_`. */
  mcp_name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What a forwarded call answers: the broker's ToolResult shape. */
export type ForwardResult = { ok: true; content: unknown } | { ok: false; error_code: string; message: string };

export const BRIDGE_SOCKET_ENV = "SF_TOOL_SOCKET";
export const BRIDGE_TOOLS_ENV = "SF_TOOL_LIST";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Serves MCP (JSON-RPC 2.0, one message per line) on `input`/`output` until `input` ends. `forward` sends a granted
 * call on to the worker; a name the bridge does not list is answered here as an error and never forwarded.
 */
export async function serveMcp(
  input: Readable,
  output: Writable,
  tools: readonly BridgeTool[],
  forward: (name: string, args: unknown) => Promise<ForwardResult>,
): Promise<void> {
  const send = (msg: unknown) => void output.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: JsonRpc["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpc["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const pending: Promise<void>[] = [];
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      fail(null, -32700, "parse error");
      continue;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    switch (msg.method) {
      case "initialize":
        reply(msg.id, {
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "software-factory-tools", version: "1" },
        });
        break;
      case "ping":
        reply(msg.id, {});
        break;
      case "tools/list":
        reply(msg.id, { tools: tools.map((t) => ({ name: t.mcp_name, description: t.description, inputSchema: t.input_schema })) });
        break;
      case "tools/call": {
        const id = msg.id;
        const tool = tools.find((t) => t.mcp_name === msg.params?.name);
        if (!tool) {
          reply(id, toolContent({ ok: false, error_code: "not_granted", message: `tool ${String(msg.params?.name)} is not granted to this run` }));
          break;
        }
        pending.push(
          forward(tool.name, msg.params?.arguments ?? {}).then(
            (r) => reply(id, toolContent(r)),
            () => reply(id, toolContent({ ok: false, error_code: "bridge_failed", message: "the worker did not answer" })),
          ),
        );
        break;
      }
      default:
        // Notifications (no id) need no answer; an unknown request gets "method not found".
        if (isRequest) fail(msg.id, -32601, `method not found: ${String(msg.method)}`);
    }
  }
  await Promise.all(pending);
}

/** A ToolResult as MCP tool content: the content (or the error) as JSON text; `isError` on an error. */
function toolContent(r: ForwardResult): { content: { type: "text"; text: string }[]; isError: boolean } {
  const text = r.ok ? JSON.stringify(r.content ?? null) : JSON.stringify({ error_code: r.error_code, message: r.message });
  return { content: [{ type: "text", text }], isError: !r.ok };
}

/**
 * Forwards calls over one connection to the run's socket: `{"id", "name", "args"}` out, `{"id", "result"}` back,
 * one JSON object per line. A closed or failed connection answers every open call as an error.
 */
export function socketForwarder(socketPath: string): { forward: (name: string, args: unknown) => Promise<ForwardResult>; close(): void } {
  const conn = createConnection(socketPath);
  const open = new Map<number, (r: ForwardResult) => void>();
  let next = 1;
  let buf = "";
  let closed: string | null = null;
  const failAll = (why: string) => {
    closed ??= why;
    for (const [id, done] of open) {
      open.delete(id);
      done({ ok: false, error_code: "bridge_failed", message: why });
    }
  };
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: ForwardResult };
        const done = typeof msg.id === "number" ? open.get(msg.id) : undefined;
        if (done && msg.result) {
          open.delete(msg.id!);
          done(msg.result);
        }
      } catch {
        // Not ours to answer: an unparsable line is dropped.
      }
    }
  });
  conn.on("error", () => failAll("the worker connection failed"));
  conn.on("close", () => failAll("the worker connection closed"));
  return {
    forward: (name, args) =>
      new Promise<ForwardResult>((resolve) => {
        if (closed !== null) return resolve({ ok: false, error_code: "bridge_failed", message: closed });
        const id = next++;
        open.set(id, resolve);
        conn.write(`${JSON.stringify({ id, name, args })}\n`);
      }),
    close: () => conn.end(),
  };
}

/** The bridge process: reads its two settings from the environment and serves MCP on stdin/stdout. */
async function main(): Promise<void> {
  const socket = process.env[BRIDGE_SOCKET_ENV];
  if (!socket) throw new Error(`${BRIDGE_SOCKET_ENV} is not set`);
  const tools = JSON.parse(process.env[BRIDGE_TOOLS_ENV] ?? "[]") as BridgeTool[];
  const fwd = socketForwarder(socket);
  await serveMcp(process.stdin, process.stdout, tools, fwd.forward);
  fwd.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`tool bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
