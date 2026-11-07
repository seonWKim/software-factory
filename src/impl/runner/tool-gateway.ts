import type { AgentRunSpec } from "../../interfaces/agent-runner.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";

/**
 * The worker side of a run's granted broker tools (docs/architecture.md §5). Every call an agent makes, through
 * the bridge or sent straight to the run's socket, ends here, in the worker process:
 *  1. the name must be in the run's `tool_grants`, and the broker must list it as read-only; otherwise the
 *     broker is never called;
 *  2. the broker's `call` gets the run's own context (run id, work item id, lease token), never one the agent
 *     sent, so the broker's lease fence holds (a run that lost its lease gets `lease_lost`);
 *  3. the result is egress-scanned (G5) before the agent sees it; a hit returns an error result instead, so the
 *     content never reaches the agent or its transcript.
 * Nothing here holds a credential: the broker's tools hold their own (G2).
 */
export interface GrantedTools {
  /** The granted tools, as the broker lists them. Only read-only ones: the others are dropped. */
  readonly tools: readonly ToolDescriptor[];
  call(name: string, args: unknown): Promise<ToolResult>;
}

export type GatewaySpec = Pick<AgentRunSpec, "run_id" | "work_item_id" | "lease_token" | "tool_grants" | "signal">;

export function grantedTools(deps: { broker: ToolBroker; scanner: EgressScanner }, spec: GatewaySpec): GrantedTools {
  const grants = [...spec.tool_grants];
  const tools = deps.broker.listTools(grants).filter((t) => t.read_only === true && grants.includes(t.name));
  const ctx: ToolCallContext = { run_id: spec.run_id, work_item_id: spec.work_item_id, lease_token: spec.lease_token };
  return {
    tools,
    async call(name: string, args: unknown): Promise<ToolResult> {
      if (typeof name !== "string" || !tools.some((t) => t.name === name)) {
        return { ok: false, error_code: "not_granted", message: `tool ${String(name)} is not granted to this run` };
      }
      if (spec.signal.aborted) return { ok: false, error_code: "lease_lost", message: "the run was stopped" };
      let result: ToolResult;
      try {
        result = await deps.broker.call(ctx, name, args);
      } catch {
        // The thrown message is not passed on: it could hold anything the tool saw.
        return { ok: false, error_code: "tool_failed", message: `tool ${name} failed` };
      }
      const scan = await deps.scanner.scan("tool_result", JSON.stringify(result) ?? "");
      if (!scan.clean) {
        return { ok: false, error_code: "egress_blocked", message: `the result of ${name} was withheld: the egress scan flagged it (${scan.findings.map((f) => f.rule).join(",")})` };
      }
      return result;
    },
  };
}
