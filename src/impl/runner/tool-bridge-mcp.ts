// The tool bridge's agent side (architecture §5, granted tools): a stdio MCP server that the `claude` process
// starts for a run with granted broker tools. It holds no credential and decides nothing: it lists what the
// worker side says the run was granted, and forwards each call over the run's local socket, whose worker side
// checks the grant, the lease and the egress scan (tool-bridge.ts).
//
// Self-contained on purpose: node built-ins only, and only type syntax node can strip, so `node <this file>`
// runs it from dist/ and from the source tree alike. Its arguments are the socket path and, for a pack MCP server's
// entry (issue #596), that server's name: every request then names it, and the worker side answers for its tools only.

import { connect } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** A broker tool's name as an MCP tool name: model APIs allow only letters, digits, `_` and `-`. */
export function mcpToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** What the bridge asks the worker side: the run's granted tools, or one call. */
export type HostRequest = { op: "list" } | { op: "call"; name: string; args: unknown };

/** The worker side's answers, as the socket carries them. */
export interface HostTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export type HostResult = { ok: true; content: unknown } | { ok: false; error_code: string; message: string };
export type HostReply = { tools: HostTool[] } | { result: HostResult } | { error: string };

export type SendToHost = (req: HostRequest) => Promise<HostReply>;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const DEFAULT_PROTOCOL = "2025-06-18";

/**
 * One MCP message in, its reply out (null for a notification). Tool names map back to broker names through the
 * last list; a name the list does not hold is forwarded unchanged, and the worker side refuses it.
 */
export function mcpHandler(send: SendToHost): (msg: JsonRpcMessage) => Promise<Record<string, unknown> | null> {
  const names = new Map<string, string>();
  const list = async (): Promise<HostTool[]> => {
    const reply = await send({ op: "list" });
    if (!("tools" in reply)) throw new Error("error" in reply ? reply.error : "no tool list");
    names.clear();
    for (const t of reply.tools) names.set(mcpToolName(t.name), t.name);
    return reply.tools;
  };
  return async (msg) => {
    const id = msg.id;
    if (id === undefined || id === null) return null; // a notification: nothing to answer
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (msg.method) {
        case "initialize": {
          const v = msg.params?.protocolVersion;
          return ok({
            protocolVersion: typeof v === "string" ? v : DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "factory-tools", version: "1.0.0" },
          });
        }
        case "ping":
          return ok({});
        case "tools/list": {
          const tools = await list();
          return ok({ tools: tools.map((t) => ({ name: mcpToolName(t.name), description: t.description, inputSchema: t.input_schema })) });
        }
        case "tools/call": {
          const asked = msg.params?.name;
          if (typeof asked !== "string") return fail(-32602, "tools/call needs a tool name");
          if (names.size === 0) await list();
          const reply = await send({ op: "call", name: names.get(asked) ?? asked, args: msg.params?.arguments ?? {} });
          if (!("result" in reply)) {
            return ok({ content: [{ type: "text", text: "error" in reply ? reply.error : "no result" }], isError: true });
          }
          const r = reply.result;
          if (!r.ok) return ok({ content: [{ type: "text", text: `${r.error_code}: ${r.message}` }], isError: true });
          const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? null);
          return ok({ content: [{ type: "text", text }] });
        }
        default:
          return fail(-32601, `method not found: ${String(msg.method)}`);
      }
    } catch (err) {
      return fail(-32603, err instanceof Error ? err.message : String(err));
    }
  };
}

/** One request over the run's socket: a fresh connection, one JSON line each way. With `server`, the request names it. */
export function socketSender(path: string, server?: string): SendToHost {
  return (req) =>
    new Promise((resolve, reject) => {
      const conn = connect(path);
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("connect", () => conn.write(`${JSON.stringify(server === undefined ? req : { ...req, server })}\n`));
      conn.on("data", (chunk: Buffer | string) => {
        buf += String(chunk);
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        conn.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as HostReply);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      conn.on("error", reject);
      conn.on("close", () => reject(new Error("the worker side closed the connection")));
    });
}

/** Serves MCP over newline-delimited JSON-RPC on stdin/stdout until stdin ends. */
export async function serveMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, send: SendToHost): Promise<void> {
  const handle = mcpHandler(send);
  const pending: Promise<void>[] = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const text = line.trim();
    if (text === "") continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      continue;
    }
    pending.push(handle(msg).then((reply) => void (reply && output.write(`${JSON.stringify(reply)}\n`))));
  }
  await Promise.all(pending);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const socket = process.argv[2];
  if (!socket) {
    process.stderr.write("usage: tool-bridge-mcp <socket path> [<pack MCP server>]\n");
    process.exit(2);
  }
  await serveMcp(process.stdin, process.stdout, socketSender(socket, process.argv[3]));
}
