import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { BRIDGE_SOCKET_ENV, BRIDGE_TOOLS_ENV, type BridgeTool } from "./tool-bridge-main.js";
import type { GrantedTools } from "./tool-gateway.js";

/** The MCP server name of the bridge; Claude Code names its tools `mcp__<server>__<tool>`. */
export const BRIDGE_SERVER = "factory";

/** The MCP name of a broker tool: every character outside [A-Za-z0-9_-] becomes `_` ("github.preflight" → "github_preflight"). */
export function mcpToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The granted tools as the bridge lists them. Throws when two names map to one MCP name. */
export function bridgeTools(tools: readonly ToolDescriptor[]): BridgeTool[] {
  const out = tools.map((t) => ({ name: t.name, mcp_name: mcpToolName(t.name), description: t.description, input_schema: t.input_schema }));
  const seen = new Set<string>();
  for (const t of out) {
    if (seen.has(t.mcp_name)) throw new Error(`granted tools ${t.name} and another map to one MCP name ${t.mcp_name}`);
    seen.add(t.mcp_name);
  }
  return out;
}

/** The names Claude Code gives the bridge's tools, for `--allowedTools`. */
export function allowedBridgeTools(tools: readonly BridgeTool[]): string[] {
  return tools.map((t) => `mcp__${BRIDGE_SERVER}__${t.mcp_name}`);
}

/** How to start the bridge: node on the compiled file, or on the source file (tests, `tsx`-less dev). */
export function bridgeCommand(): { command: string; args: string[] } {
  const js = fileURLToPath(new URL("./tool-bridge-main.js", import.meta.url));
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  const ts = fileURLToPath(new URL("./tool-bridge-main.ts", import.meta.url));
  return { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", ts] };
}

/**
 * The `--mcp-config` for a run: one stdio server, the bridge, whose environment is the socket path and the tool
 * list. No credential, no secret name, nothing from the worker's environment (tests/tool-bridge.test.ts checks it).
 */
export function bridgeMcpConfig(socketPath: string, tools: readonly BridgeTool[], cmd = bridgeCommand()): Record<string, unknown> {
  return {
    mcpServers: {
      [BRIDGE_SERVER]: {
        type: "stdio",
        command: cmd.command,
        args: cmd.args,
        env: { [BRIDGE_SOCKET_ENV]: socketPath, [BRIDGE_TOOLS_ENV]: JSON.stringify(tools) },
      },
    },
  };
}

/**
 * One line from the run's socket, answered through `gateway` (which checks the grant): `{"id", "result"}`, or null
 * for a line that is not a JSON object. Exported so the refusal can be tested without a socket.
 */
export async function answerLine(gateway: GrantedTools, line: string): Promise<{ id: unknown; result: ToolResult } | null> {
  let msg: { id?: unknown; name?: unknown; args?: unknown };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const result = await gateway.call(msg.name as string, msg.args).catch(
    (): ToolResult => ({ ok: false, error_code: "tool_failed", message: "the tool call failed" }),
  );
  return { id: msg.id, result };
}

/** The open socket of one run: its path, and close() to stop it and remove its folder. */
export interface ToolSocket {
  path: string;
  close(): Promise<void>;
}

/**
 * Opens the run's local socket in the worker process (a Unix socket in a fresh 0700 folder). Each line is one
 * call `{"id", "name", "args"}`; the answer is `{"id", "result"}`. Every call goes through `gateway`, which checks
 * the grant, so a call naming another tool is refused whoever sends it: the bridge, or the agent itself.
 */
export async function openToolSocket(gateway: GrantedTools, dir?: string): Promise<ToolSocket> {
  const folder = dir ?? (await mkdtemp(join(tmpdir(), "sf-tools-")));
  const path = join(folder, "tools.sock");
  const conns = new Set<Socket>();
  const server: Server = createServer((conn) => {
    conns.add(conn);
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void answerLine(gateway, line).then((out) => {
          if (out && !conn.destroyed) conn.write(`${JSON.stringify(out)}\n`);
        });
      }
    });
    conn.on("error", () => conn.destroy());
    conn.on("close", () => conns.delete(conn));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    close: async () => {
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!dir) await rm(folder, { recursive: true, force: true });
    },
  };
}
