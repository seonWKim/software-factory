import type { RunId, WorkItemId } from "../core/types.js";

// G2: credentialed actions run here, in the worker process, outside the sandbox.
// The agent sends a tool name + args and gets a result back, never the credential.

export interface ToolDescriptor {
  name: string; // e.g. "github.push", "github.open_pr", "github.comment"
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
}

export interface ToolCallContext {
  run_id: RunId;
  work_item_id: WorkItemId;
  /** Lease fencing token. The broker rejects calls from a run that lost its lease. */
  lease_token: number;
}

export type ToolResult =
  | { ok: true; content: unknown }
  | { ok: false; error_code: string; message: string };

export interface ToolBroker {
  /** Tools this run may call. Finding a tool is not permission (design §7): the grant list decides. */
  listTools(grants: readonly string[]): ToolDescriptor[];
  /** Results pass through the EgressScanner before returning to the agent. */
  call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult>;
}
