import type { CheckRound } from "../core/checks.js";
import type { GateEntry } from "../core/config.js";
import type { SelectionMode, TestSelectionConfig } from "../core/test-selection.js";
import type { ToolSpec } from "../core/tools/types.js";
import type { Run, RunId, RunKind, WorkItemId } from "../core/types.js";
import type { FactoryStore } from "./factory-store.js";
import type { LLMImage } from "./llm-provider.js";
import type { SandboxHandle } from "./sandbox.js";

// The tool-using loop. First impl: ClaudeCodeRunner (`claude -p` in the sandbox workdir).

/**
 * The role an agent step runs as: its run's kind, or `review-confirm`, the review run's confirm step per finding
 * (design 04-agents), which runs inside a review run with its own role, prompt and tools.
 */
export type AgentRole = RunKind | "review-confirm";

export interface AgentRunSpec {
  run_id: RunId;
  work_item_id: WorkItemId;
  role: AgentRole;
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
  /**
   * The approved pack MCP servers the run kind grants (`pack:mcp_server:<name>`, design 11-packs), stdio only and
   * with no credential. A runner that runs them (`runs_mcp_servers`) starts each, and every result reaches the agent
   * through the same egress scan and output cap as a granted broker tool. Absent: none.
   */
  mcp_servers?: readonly PackMcpServer[];
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
  /**
   * The declared toolchain caches (`toolchain.caches`, design 05-sandbox.md): the agent may read them, never
   * write them; `deny_paths` still wins inside them. Every runner passes them to `guardPolicy`, and a harness to
   * its read allow list only. Absent: none, and the harness settings are as before.
   */
  readable_paths?: readonly string[];
  /**
   * `toolchain.env`: non-secret entries for the agent's environment, checked at startup (G1, key and value). Set,
   * even empty, only when config has a `toolchain` block; a runner then also points the per-run toolchain homes
   * into the run's temp folder. Absent: the agent environment is as before.
   */
  toolchain_env?: Readonly<Record<string, string>>;
  /**
   * Warmed Gradle wrapper distributions (the owner's `~/.gradle/wrapper/dists`, design 05-sandbox.md): absolute
   * folders a runner copies, before the agent starts, into the run's own `GRADLE_USER_HOME`
   * (`<TMPDIR>/toolchain/gradle/wrapper/dists`). Copied only: never linked, never written, never readable to the
   * agent. Set, even empty, only with a `toolchain` block; a missing folder is skipped.
   */
  toolchain_seeds?: readonly string[];
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
  /**
   * The gate Stop check's time limit (design §4 Pre-push gates): the live `agent_stop_check_ms`, read for each run.
   * Used only with `gate_hooks`. Absent: the `agent_stop_check_ms` setting file's default.
   */
  stop_check_ms?: number;
  /** JSON Schema the final answer must match. */
  output_schema?: Record<string, unknown>;
  /**
   * Images the model gets as image input with the prompt (design 02-attachments): triage's attached images, base64,
   * handed to the harness on stdin, never written to the sandbox's working tree. A runner that takes no image input
   * ignores them; the prompt still names each one. Absent: none.
   */
  images?: readonly AgentImage[];
  /** Abort when the worker loses its lease, or when `workers pause` stops the run (design §5 Pause). */
  signal: AbortSignal;
  /**
   * The live transcript (design 09-dashboard-item): a runner that streams its output calls this with the output so
   * far, as text, each time it grows; the worker stores it, throttled and egress-scanned, while the run is running.
   * Synchronous and cheap; it never throws. Absent, or a runner that does not stream: the transcript is stored
   * only when the step ends.
   */
  live?: (output: string) => void;
  /**
   * Model output (design 05-restarts): a runner that watches its stream calls this each time the model prints (the
   * events that restart its stall clock), so the worker can store when the run last got output. Synchronous and
   * cheap; it never throws. Absent, or a runner that does not watch its stream: nothing is reported.
   */
  on_output?: () => void;
  /**
   * Context of each model call (design 05-restarts, context ceiling): a runner that reads its stream calls this once per
   * model call with that call's context, its input plus cache read plus cache write tokens. Synchronous and cheap; it
   * never throws. Absent, or a runner that does not read its stream: nothing is reported and no ceiling applies.
   */
  on_context?: (tokens: number) => void;
  /**
   * The agent session (design §5 Pause). Kept only for the roles in SESSION_ROLES and only when given: `id` names
   * a new session, or with `resume` the stored one this call continues. Absent, or another role: the runner
   * keeps no session, so nothing is left behind and nothing can be resumed.
   */
  session?: { id: string; resume: boolean };
  /**
   * The gate hooks (design §4 Pre-push gates, issue #302): given only for the implement run's main and fix steps.
   * A runner that supports them refuses an Edit or Write outside `allowed_paths` and sends a stop back while the
   * worker's gates would fail it. Advisory: the worker's gates still decide. Absent: no hooks.
   */
  gate_hooks?: GateHooks;
  /**
   * The run's host test slot (design 04-pre-push-gates, test slots): the Stop check runs a full test command under
   * it, and its limit and the run timeout do not count while it waits. Given with `gate_hooks`; absent: no slot.
   */
  test_slot?: TestSlotHold;
}

/**
 * A run's host test slot as a check runs under it (src/worker/test-slot.ts): one per run, renewed by the worker's
 * heartbeat. Only a full test command (argv equal to `repo.test_command`, no test files added) holds it.
 */
export interface TestSlotHold {
  /**
   * `commands` through `run` in order, stopping at the first failure, as one `run` call would: the full test command
   * on its own call under the slot, every other command with no slot. For the slot it waits (on the worker's clock),
   * runs, then frees the slot, also on a throw or an abort; if a renewal finds the slot gone, that call's signal
   * aborts, the run waits for a new slot and the command runs again. `unwrap`: the command as configured, for a
   * caller that wraps each one; absent: as given.
   */
  runChecks(commands: readonly GateEntry[], signal: AbortSignal, run: (commands: readonly GateEntry[], signal: AbortSignal) => Promise<CheckRound>, unwrap?: (entry: GateEntry) => GateEntry): Promise<CheckRound>;
  /** Whether the run is waiting for a slot now: no time limit counts while it does. */
  waiting(): boolean;
}


/** One image for the model: its type (png, jpeg, gif or webp) and its bytes, base64; the LLM call's image too. */
export type AgentImage = LLMImage;

/**
 * A pack MCP server as a run gets it: its approved descriptor's `command` and `args`. It always starts with an
 * empty env, so it holds no secret value.
 */
export interface PackMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** What the gate hooks check against: the same values the worker's gates use. Holds no secret value. */
export interface GateHooks {
  allowed_paths: readonly string[];
  /** HEAD when the run's agent work started: its own commits are `<start_sha>..HEAD`. */
  start_sha: string;
  /** The base the gates diff against (`<base_sha>...HEAD`), and the no-commit fallback (`--no-merges <base_sha>..HEAD`). */
  base_sha: string;
  limits: { max_diff_lines: number; max_diff_files: number };
  /** `repo.check_commands`, in order, each in its folder (design 04-gate-commands); the Stop hook stops at the first failure. */
  check_commands: readonly GateEntry[];
  /** The env the Stop hook's git reads and checks run with: the worker's tool env, never a credential or test database URL. */
  check_env: Readonly<Record<string, string>>;
  /** `agent_stop_checks`: the most times the Stop hook blocks in one run. */
  stop_checks: number;
  /** Stop blocks earlier steps of this run already used. */
  stop_blocks_used: number;
  /**
   * The enabled `on_tool_call` pack checks (design §4, issue #494), bound to the run. A runner that supports them
   * (`supports_tool_hooks`) runs them on each Edit or Write before the allowed_paths check, with the tool name and
   * file path after each check's argv, never the file content. A refusal, a crash or a timeout refuses the edit;
   * a pass approves nothing (the path check still runs). Absent: none enabled.
   */
  on_tool_call?: PackGate;
  /**
   * The Stop check's test selection (design §4): the project's stored mode, read per step as the check before push
   * reads it, with `repo.test_command` and `repo.test_selection`. The Stop check narrows its check list with the check
   * before push's own rule (`selectedChecks`) and counts nothing toward the mode switch. Absent: the check list whole.
   */
  selection?: StopSelection;
}

/** What the Stop check narrows its test command with: the stored mode and the repo's selection config. */
export interface StopSelection {
  mode: SelectionMode;
  test_command: string[];
  test_selection: TestSelectionConfig;
}

/** The points a pack check runs at; the same list as PACK_CHECK_POINTS in src/shared/hook.ts. */
export type PackCheckPoint = "before_agent" | "on_tool_call" | "before_finish" | "after_agent";

/** A pack check that refused: its name, why (untrusted text: its output's last lines, or its crash or timeout), and its `retries`. */
export interface PackRefusal {
  check: string;
  reason: string;
  retries: number;
}

/**
 * The enabled pack checks of one point, bound to one run: its sandbox and the worker's tool env, never a credential.
 * Holds no secret value.
 */
export interface PackGate {
  /** The checks' names, in the order they run. */
  readonly checks: readonly string[];
  /**
   * Runs each check in order, `args` after its argv; the first refusal stops the rest and is audited. A crash or a
   * timeout is a refusal, and so is an abort before every check ran. Null: no objection, which approves nothing.
   */
  run(args: readonly string[], signal: AbortSignal): Promise<PackRefusal | null>;
  /**
   * `before_finish` (decision 2 of issue #494): runs the checks; each refusal sends the agent back through `fix`
   * and runs them again, until none objects (null) or one check refused more times than its `retries` (that
   * refusal: the run fails). The counts live in this call only, in the run's process memory.
   */
  untilPassed(fix: (r: PackRefusal) => Promise<void>, signal: AbortSignal): Promise<PackRefusal | null>;
}

/** The enabled pack checks of a factory (the names in `hooks`), loaded at startup. */
export interface PackChecks {
  /** The checks at `point`, bound to one run; null when none is enabled there. */
  at(point: PackCheckPoint, run: { subject: string; project_id: string; sandbox: SandboxHandle; env: Readonly<Record<string, string>> }): PackGate | null;
}

/** One time a gate hook sent the agent back: which hook, the check that failed, and its attempt number in the run. */
export interface GateBlock {
  hook: "pre_tool_use" | "stop";
  /** `allowed_paths`, `no_commits`, `diff_too_large`, the failing check command, or `pack:<name>` (an on_tool_call pack check). */
  check: string;
  attempt: number;
}

/** The roles whose agent sessions a runner keeps (design §5 Pause): triage, update and review-confirm never keep one. */
export const SESSION_ROLES: readonly AgentRole[] = ["implement", "review", "resolve"];

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
   * Why a `failed` run failed, when the runner can tell it needs a person: `provider_setup` (the provider's quota,
   * API key or model name, design §5 Restarts). The worker records it as the error code and the run is not
   * retried. Absent: the worker's own code for the status.
   */
  code?: typeof PROVIDER_SETUP;
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
  /** Each time a gate hook sent the agent back in this call, in order (`AgentRunSpec.gate_hooks`). */
  gate_blocks?: GateBlock[];
  /** The test selection line each Stop check of this call logged (`test selection (<mode>): …`), in order (`GateHooks.selection`). */
  stop_selections?: string[];
}

/** The error code of a run the provider refused for its account or config: quota, API key or model name. */
export const PROVIDER_SETUP = "provider_setup";

export interface AgentRunner {
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
  /**
   * Whether this runner can expose granted broker tools to its agent (`AgentRunSpec.tool_grants`). Absent: false.
   * The worker refuses a run with grants on a runner that does not; such a runner also fails the run itself,
   * with an error naming the granted tools, rather than ignore them.
   */
  readonly exposes_tools?: boolean;
  /**
   * Whether this runner starts the run's pack MCP servers (`AgentRunSpec.mcp_servers`) and routes their results
   * through the egress scan and output cap. Absent: false, and the worker refuses a run granted one as `not_started`
   * before its agent starts.
   */
  readonly runs_mcp_servers?: boolean;
  /**
   * Whether this runner runs `GateHooks.on_tool_call` on each Edit or Write (design §4, issue #494). Absent: false,
   * and startup refuses an enabled `on_tool_call` pack check, naming the check and the point.
   */
  readonly supports_tool_hooks?: boolean;
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

/** The failure detail's code word for a gate Stop check that ran out its limit (`AgentRunSpec.stop_check_ms`). */
export const STOP_CHECK_TIMED_OUT = "stop_check_timed_out";
/** How far back a `stop_check_timed_out` detail looks for merge-check runs, and how many it names at most. */
export const MERGE_CHECK_LOOKBACK_MS = 86_400_000;
export const MERGE_CHECK_TIMES = 5;

/**
 * A failed step's detail: the runner's error. A `stop_check_timed_out` one also says how long the merge-check runs
 * that finished in the last MERGE_CHECK_LOOKBACK_MS took (newest first, from the store's finished runs), since those
 * run the whole check list: the measure to set `agent_stop_check_ms` by.
 */
export async function runFailureDetail(result: Pick<AgentRunResult, "error">, store: Pick<FactoryStore, "listRunsFinishedWithin">): Promise<string> {
  const error = result.error ?? "";
  if (!error.startsWith(`${STOP_CHECK_TIMED_OUT}: `)) return error;
  const took = (await store.listRunsFinishedWithin(MERGE_CHECK_LOOKBACK_MS)).filter((r) => r.kind === "merge-check" && r.status === "succeeded").map(runMinutes)
    .filter((m): m is number => m !== null).slice(0, MERGE_CHECK_TIMES);
  return took.length === 0
    ? `${error}; no merge-check run finished in the last ${MERGE_CHECK_LOOKBACK_MS / 3_600_000} hours`
    : `${error}; recent merge-check runs took ${took.map((m) => `${m} min`).join(", ")} (newest first)`;
}

/** A finished run's length in whole minutes, rounded up; null without both times. */
function runMinutes(r: Pick<Run, "started_at" | "finished_at">): number | null {
  if (!r.started_at || !r.finished_at) return null;
  return Math.ceil((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60_000);
}
