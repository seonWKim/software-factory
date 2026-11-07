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
  /**
   * ToolBroker tools granted to the agent: the run kind's `tool_grants` from factory.config.json, checked at
   * startup to be read-only tools the broker lists. Empty when config grants none (the default). A runner that
   * cannot expose tools (`exposes_tools` absent or false) refuses a run with any grant.
   */
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
  /**
   * Silence limit (design §5 Restarts): a run whose model produces no output (system events do not count) for
   * this long, while no tool call is in progress, ends `stalled`. Absent: the runner's default (300000).
   * `timeout_ms` still bounds it.
   */
  stall_ms?: number;
  /**
   * First-output limit (design §5 Restarts, issue #215): a run whose model produces no output within this long
   * of the start ends `stalled`. Absent: the runner's default (180000).
   */
  first_output_ms?: number;
  /** JSON Schema the final answer must match. */
  output_schema?: Record<string, unknown>;
  /** Abort when the worker loses its lease, or when `workers pause` stops the run (design §5 Pause). */
  signal: AbortSignal;
  /**
   * The agent session (design §5 Pause). Kept only for the roles in SESSION_ROLES and only when given: `id` names
   * a new session, or with `resume` the stored one this call continues. Absent, or another role: the runner
   * keeps no session, so nothing is left behind and nothing can be resumed.
   */
  session?: { id: string; resume: boolean };
}

/** The roles whose agent sessions a runner keeps (design §5 Pause): triage and update never keep one. */
export const SESSION_ROLES: readonly RunKind[] = ["implement", "review", "resolve"];

export interface AgentRunResult {
  /**
   * `rate_limited`: the model provider refused for a usage or rate limit. Not a failed attempt; the
   * factory pauses every claim until `reset_at` (design §5 Restarts). Each runner maps its own harness's
   * signal to this; core never parses harness text.
   * `stalled`: the harness reported nothing for `stall_ms` while no tool call was open (the model is not
   * answering). Not a failed attempt either; the factory pauses claims until a probe gets an answer.
   */
  status: "completed" | "failed" | "timed_out" | "aborted" | "rate_limited" | "stalled";
  /** Final structured answer, if any. Not yet egress-scanned: the caller scans it before storing (G5). */
  output: unknown;
  /** Raw harness output. Not yet egress-scanned: the caller scans it before storing anywhere (G5). */
  transcript: string;
  /**
   * What the call used, from the harness's own report. Filled for every status when the harness printed one
   * (also on timeout and abort). A killed call that printed no final report: what its stream reported per
   * message before the kill, with a null cost; zeros and a null cost when it printed nothing. The cache counts and model are
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
  /**
   * Whether the agent called a write-capable tool (capability write or exec) in this call, so its workdir may have
   * changed. A fallback chain does not hand such a workdir to the next member on a stall (design §5 Restarts).
   * Absent: the runner cannot tell.
   */
  did_work?: boolean;
  /** For `rate_limited`: when the limit resets (ISO-8601 UTC), if the runner could tell. */
  reset_at?: string;
  /**
   * The agent's last progress note (its latest plain text before it stopped), when the runner could tell. A
   * pause uses it as the handoff's next steps. Agent text: the caller scans it before storing it (G5).
   */
  last_note?: string;
  /** The chain member that produced this result (design 2026-11-07): its plugin name. Set by a fallback chain. */
  served_by?: string;
  /** Each fall-over in this run, in order: the member that gave up, the next one tried, and why. */
  fallbacks?: { from: string; to: string; reason: string }[];
}

export interface AgentRunner {
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
  /**
   * Whether this runner can expose granted broker tools to its agent (`AgentRunSpec.tool_grants`). Absent: false.
   * The worker refuses a run with grants on a runner that does not; such a runner also fails the run itself,
   * with an error naming the granted tools, rather than ignore them.
   */
  readonly exposes_tools?: boolean;
  /**
   * Whether session `id` is stored on this host and readable, so `--resume` can continue it. Absent: sessions
   * are never resumed (a paused run starts a new session from its WIP commit and handoff).
   */
  hasSession?(id: string): Promise<boolean>;
  /** Removes session `id` from this host. Idempotent; safe for a session that is already gone. */
  removeSession?(id: string): Promise<void>;
}

/** The error code and message of a run refused because its runner cannot expose its granted tools. */
export const TOOLS_NOT_EXPOSED = "tools_not_exposed";
export function toolsNotExposedMessage(grants: readonly string[]): string {
  return `this agent runner cannot expose broker tools to its agent; granted: ${grants.join(", ")}`;
}
