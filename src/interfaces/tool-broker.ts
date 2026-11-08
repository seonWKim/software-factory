import type { RunId, WorkItemId } from "../core/types.js";

// G2: credentialed actions run here, in the worker process, outside the sandbox.
// The agent sends a tool name + args and gets a result back, never the credential.

/**
 * The run's last trusted step (RFC 0015 M7): the run folder's HEAD written to a ref of the factory repo, after the
 * trusted-git checks and the G5 branch scan. Args `{ workdir, branch, base_ref }`; content `{ sha, forge }`:
 * `forge` true when the commit still has to reach the forge (the worker then records the push and PR intents
 * outbound delivers), false when the factory repo's branch is the change itself (the local broker).
 */
export const STORE_BRANCH = "git.store_branch";

export interface ToolDescriptor {
  name: string; // e.g. "github.push_branch", "github.open_pr"
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
  /**
   * True only for a tool that changes nothing anywhere: no push, no write, no comment, no state. Only read-only
   * tools may be granted to an agent run (`tool_grants` in factory.config.json); startup refuses any other.
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
   * Every tool this broker serves, granted or not: what startup checks `tool_grants` against.
   */
  allTools(): readonly ToolDescriptor[];
  /** Results pass through the EgressScanner before returning to the agent. */
  call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult>;
}

/** What a run passport is minted for (RFC 0015 §8 "Run passports"). */
export interface RunPassportRequest {
  run: RunId;
  /** The claim's lease token: only the holder of this token's claim may `end` the passport. */
  lease_token: number;
  /** The run kind: picks the broker tools the passport names. */
  kind: string;
  item: WorkItemId;
  project: string;
  /** The run's branch (`factory/<item>` or the item's head branch): with `wip_branch`, the only branches its tools may touch. */
  branch: string;
  /**
   * The run's work-in-progress branch (an implement run's `factory/wip/<item>/<run>`): where a stopped or failed run
   * keeps its commits for the retry (design §5 Restarts). Absent: the run keeps none.
   */
  wip_branch?: string;
  /** The read-only tools `tool_grants` gives this run kind. */
  grants: readonly string[];
}

/**
 * G2's run passports: the worker mints one at run start, narrowed from its service passport to the run, and the
 * broker checks it on every call (src/impl/broker/passport-broker.ts). A broker call for a run with no passport is
 * refused. `begin` throws when Identity refuses to narrow (a revoked worker passport), and the run fails.
 */
export interface RunPassportIssuer {
  begin(req: RunPassportRequest): Promise<unknown>;
  /**
   * Forgets the run's token if this claim (`lease_token`) minted it; the passport itself expires with its parent.
   * A slot that lost the run never drops the passport of the claim that took it over.
   */
  end(run: RunId, lease_token: number): void;
}
