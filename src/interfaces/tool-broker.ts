import type { RunId, WorkItemId } from "../core/types.js";

// G2: credentialed actions run here, in the worker process, outside the sandbox.
// The agent sends a tool name + args and gets a result back, never the credential.

export interface ToolDescriptor {
  name: string; // e.g. "github.push", "github.open_pr", "github.comment"
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
  /**
   * True only for a tool that changes nothing anywhere (no push, no PR, no comment, no write): it reads. Only a
   * read-only tool may be granted to an agent run through `tool_grants` (docs/architecture.md §5).
   */
  read_only: boolean;
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
  /**
   * Every tool this broker serves, granted or not. Read only by the startup check of `tool_grants`, so its errors
   * can list the valid names; listing a tool here grants nothing. Absent: the check knows only the names it asks
   * `listTools` for.
   */
  catalog?(): ToolDescriptor[];
  /** Results pass through the EgressScanner before returning to the agent. */
  call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult>;
}
