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
  /** Harness built-in tools the agent may use, e.g. ["Read", "Grep"]. */
  harness_tools: readonly string[];
  /** ToolBroker tools granted to the agent. Phase 1: always empty; the worker calls the broker itself. */
  tool_grants: readonly string[];
  lease_token: number;
  /** Non-secret env vars allowed into the agent process (G1). The runner adds only the harness credential. */
  env_allowlist: Readonly<Record<string, string>>;
  /** Paths the harness must deny for file and shell tools (G4) and at OS level (G3). */
  deny_paths: readonly string[];
  /** Paths outside the workdir the agent's shell may write to (e.g. the repo's .git for worktree commits). */
  writable_paths: readonly string[];
  model_class: "cheap" | "strong";
  timeout_ms: number;
  /** JSON Schema the final answer must match. */
  output_schema?: Record<string, unknown>;
  /** Abort when the worker loses its lease. */
  signal: AbortSignal;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "timed_out" | "aborted";
  /** Final structured answer, if any. Not yet egress-scanned: the caller scans it before storing (G5). */
  output: unknown;
  /** Raw harness output. Not yet egress-scanned: the caller scans it before storing anywhere (G5). */
  transcript: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number | null };
  error?: string;
}

export interface AgentRunner {
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
}
