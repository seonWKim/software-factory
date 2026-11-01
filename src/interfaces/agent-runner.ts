import type { ToolSpec } from "../core/tools/types.js";
import type { RunId, RunKind, WorkItemId } from "../core/types.js";
import type { SandboxHandle } from "./sandbox.js";

// The tool-using loop. First impl: ClaudeCodeRunner (`claude -p` in the sandbox workdir).

export interface AgentRunSpec {
  run_id: RunId;
  work_item_id: WorkItemId;
  role: RunKind;
  sandbox: SandboxHandle;
  system_prompt: string;
  prompt: string;
  /**
   * The agent's file and shell tools, as specs from the shared module (src/core/tools): the runner exposes
   * exactly these, in this order, and adds none. Each carries its capability (read, write or exec), so a
   * read-only role is checkable from the spec alone. Path and env rules come from `guardPolicy` over
   * deny_paths, writable_paths and env_allowlist, shared by the tools and every runner.
   */
  tools: readonly ToolSpec[];
  /** ToolBroker tools granted to the agent. Phase 1: always empty; the worker calls the broker itself. */
  tool_grants: readonly string[];
  lease_token: number;
  /** Non-secret env vars allowed into the agent process (G1). The runner adds only the harness credential. */
  env_allowlist: Readonly<Record<string, string>>;
  /** Paths the harness must deny for file and shell tools (G4) and at OS level (G3). */
  deny_paths: readonly string[];
  /**
   * Paths outside the workdir the agent's shell may write to. Never the owner's checkout or its `.git`
   * (architecture §5): the run's git folder is inside its workdir, so implement runs need none.
   */
  writable_paths: readonly string[];
  model_class: "cheap" | "standard" | "strong";
  timeout_ms: number;
  /** JSON Schema the final answer must match. */
  output_schema?: Record<string, unknown>;
  /** Abort when the worker loses its lease. */
  signal: AbortSignal;
}

export interface AgentRunResult {
  /**
   * `rate_limited`: the model provider refused for a usage or rate limit. Not a failed attempt; the
   * factory pauses every claim until `reset_at` (design §5 Restarts). Each runner maps its own harness's
   * signal to this; core never parses harness text.
   */
  status: "completed" | "failed" | "timed_out" | "aborted" | "rate_limited";
  /** Final structured answer, if any. Not yet egress-scanned: the caller scans it before storing (G5). */
  output: unknown;
  /** Raw harness output. Not yet egress-scanned: the caller scans it before storing anywhere (G5). */
  transcript: string;
  /**
   * What the call used, from the harness's own report. Filled for every status when the harness printed one
   * (also on timeout and abort); zeros and a null cost when it printed none. The cache counts and model are
   * optional so older test doubles still compile; absent counts as 0 and null.
   */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    /** The harness's cost figure in USD; null when it gave none. */
    cost_usd: number | null;
    model?: string | null;
  };
  error?: string;
  /** For `rate_limited`: when the limit resets (ISO-8601 UTC), if the runner could tell. */
  reset_at?: string;
}

export interface AgentRunner {
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
}
