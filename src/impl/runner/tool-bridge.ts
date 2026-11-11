// The tool bridge's worker side (architecture §5, granted tools). For a run with granted broker tools the runner
// opens a local socket that only this run's bridge is told about; every request on it, whoever sends it, goes
// through ToolGate: the grant list, the lease, the broker's own call (which attaches any credential and fences on
// the lease token), then the egress scan of the result, then the output cap. Nothing here hands a credential to the
// agent side.

import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunSpec } from "../../interfaces/agent-runner.js";
import { OUTPUT_CAP } from "../../core/tools/index.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { type JsonLineHost, startJsonLineHost } from "./json-line-host.js";
import { type HostReply, mcpToolName } from "./tool-bridge-mcp.js";

/** What a runner needs to expose granted tools: the broker that serves them and the scanner for their results. */
export interface GrantedToolDeps {
  broker: ToolBroker;
  scanner: EgressScanner;
}

/** `sandbox.workdir` is the run folder, where a result over the cap is written; without it such a result is cut. */
export type GateSpec = Pick<AgentRunSpec, "run_id" | "work_item_id" | "lease_token" | "tool_grants" | "signal"> & {
  sandbox?: Pick<AgentRunSpec["sandbox"], "workdir">;
};

/** The error codes a granted-tool call returns to the agent when the gate, not the tool, answers. */
export const NOT_GRANTED = "not_granted";
export const LEASE_LOST = "lease_lost";
export const EGRESS_BLOCKED = "egress_blocked";

/** A result whose text is longer than this many bytes goes to a file in the run folder (the shared tools' cap). */
export const RESULT_CAP_BYTES = OUTPUT_CAP;
/** The bytes of a capped result the agent still gets in place. */
export const RESULT_PREVIEW_BYTES = 2 * 1024;
/** The run folder's subfolder for capped results; it holds a `.gitignore` of `*`, so no result is ever committed. */
export const RESULT_DIR = ".factory-tool-results";

/**
 * One run's granted tools. `list` is what the agent may see; `call` is the only way a call reaches the broker:
 * a name outside the grant list (or not read-only) is refused without calling the broker, a run that lost its
 * lease gets `lease_lost` without calling it, a result the egress scan flags is withheld, and a result over the cap
 * comes back as its file's path and its first 2 KB.
 */
export class ToolGate {
  private readonly ctx: ToolCallContext;
  private capped = 0;

  constructor(
    private readonly deps: GrantedToolDeps,
    private readonly spec: GateSpec,
  ) {
    this.ctx = { run_id: spec.run_id, work_item_id: spec.work_item_id, lease_token: spec.lease_token };
  }

  /** The granted tools the broker lists, read-only ones only. */
  list(): ToolDescriptor[] {
    const grants = this.spec.tool_grants;
    return this.deps.broker.listTools(grants).filter((t) => grants.includes(t.name) && t.read_only);
  }

  async call(name: unknown, args: unknown): Promise<ToolResult> {
    const tool = typeof name === "string" ? this.list().find((t) => t.name === name) : undefined;
    if (!tool) {
      const granted = this.spec.tool_grants.length > 0 ? this.spec.tool_grants.join(", ") : "(none)";
      return { ok: false, error_code: NOT_GRANTED, message: `tool ${JSON.stringify(name)} is not granted to this run; granted: ${granted}` };
    }
    // The worker aborts the run's signal when its heartbeat loses the lease; the broker also fences on the token.
    if (this.spec.signal.aborted) return { ok: false, error_code: LEASE_LOST, message: "run no longer holds its lease" };
    let result: ToolResult;
    try {
      result = await this.deps.broker.call(this.ctx, tool.name, args);
    } catch {
      // The thrown text could hold anything the tool saw; the agent gets only that the call failed.
      return { ok: false, error_code: "tool_error", message: `${tool.name} failed` };
    }
    // G5 on everything that goes back to the agent: the content, or the error text of a failed call.
    const scan = await this.deps.scanner.scan("tool_result", JSON.stringify(result));
    if (!scan.clean) {
      const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
      return { ok: false, error_code: EGRESS_BLOCKED, message: `${tool.name} result withheld: the egress scan flagged it (${rules})` };
    }
    return result.ok ? this.cap(tool.name, result.content) : result;
  }

  /**
   * The output cap, after the egress scan: content whose text is over RESULT_CAP_BYTES is written whole to a file
   * in the run folder, and the agent gets `{ truncated, path, bytes, preview }`, the preview its first 2 KB. With
   * no run folder, `path` is null and the rest of the text is dropped.
   */
  private async cap(name: string, content: unknown): Promise<ToolResult> {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const bytes = Buffer.from(text ?? "", "utf8");
    if (bytes.length <= RESULT_CAP_BYTES) return { ok: true, content };
    const preview = bytes.subarray(0, RESULT_PREVIEW_BYTES).toString("utf8");
    const workdir = this.spec.sandbox?.workdir;
    let path: string | null = null;
    if (workdir !== undefined) {
      const dir = join(workdir, RESULT_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".gitignore"), "*\n");
      this.capped += 1;
      path = join(dir, `${this.spec.run_id}-${this.capped}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
      await writeFile(path, bytes);
    }
    return { ok: true, content: { truncated: true, path, bytes: bytes.length, preview } };
  }
}

/** One socket request, answered through the gate. Anything malformed gets an error reply, never a broker call. */
export async function answerBridgeRequest(gate: ToolGate, req: unknown): Promise<HostReply> {
  const r = (typeof req === "object" && req !== null ? req : {}) as { op?: unknown; name?: unknown; args?: unknown };
  if (r.op === "list") {
    return { tools: gate.list().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) };
  }
  if (r.op === "call") return { result: await gate.call(r.name, r.args) };
  return { error: "unknown request" };
}

/** A request line longer than this is refused and the connection closed. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** The run's socket; `socket` is the path the bridge connects to. */
export type RunningBridge = JsonLineHost;

/**
 * Opens the run's socket (`startJsonLineHost`). One JSON line in, one JSON line out, per request, on a connection
 * that stays open.
 */
export function startBridgeHost(gate: ToolGate): Promise<RunningBridge> {
  return startJsonLineHost("sf-tools-", MAX_REQUEST_BYTES, (req, conn) => {
    void answerBridgeRequest(gate, req).then(
      (reply) => conn.writable && conn.write(`${JSON.stringify(reply)}\n`),
      () => conn.writable && conn.write(`${JSON.stringify({ error: "request failed" })}\n`),
    );
  });
}

/** The MCP server name the bridge runs under; Claude Code names its tools `mcp__<server>__<tool>`. */
export const BRIDGE_SERVER = "factory_tools";

/** The name the agent's harness gives a granted broker tool, for `--allowedTools`. */
export function harnessToolName(brokerName: string): string {
  return `mcp__${BRIDGE_SERVER}__${mcpToolName(brokerName)}`;
}

/** The bridge script beside this module: `.js` under dist/, `.ts` in the source tree. */
export function bridgeScript(): string {
  const here = fileURLToPath(import.meta.url);
  return join(here, "..", `tool-bridge-mcp${extname(here)}`);
}

/**
 * The `--mcp-config` for a run: one stdio server, `node <bridge script> <socket>`. No env of its own and no
 * credential: the harness starts it with its scrubbed subprocess env, and the socket path is all it is told.
 */
export function bridgeMcpConfig(socket: string, opts: { node?: string; script?: string } = {}): Record<string, unknown> {
  return {
    mcpServers: {
      [BRIDGE_SERVER]: { type: "stdio", command: opts.node ?? process.execPath, args: [opts.script ?? bridgeScript(), socket], env: {} },
    },
  };
}
