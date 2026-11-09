import { access, constants, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { toolchainCacheOverlaps } from "../../core/config.js";
import { FORBIDDEN_ENV, guardPolicy } from "../../core/tools/index.js";
import { toolchainEnvKeyRefusal } from "../../core/tools/policy.js";
import {
  type AgentRunResult, type AgentRunSpec, type AgentRunner, SESSION_ROLES, toolsNotExposedMessage,
} from "../../interfaces/agent-runner.js";
import type { Sandbox } from "../../interfaces/sandbox.js";
import { type SecretStore, secretName } from "../../interfaces/secret-store.js";
import { GATE_HOOKS_DIR, type RunningGateHooks, startGateHooks } from "./gate-hooks.js";
import { type GrantedToolDeps, type RunningBridge, ToolGate, bridgeMcpConfig, harnessToolName, startBridgeHost } from "./tool-bridge.js";

export interface ClaudeCodeRunnerOptions {
  sandbox: Sandbox;
  secrets: SecretStore;
  /** CLAUDE_CONFIG_DIR for agent runs: keeps the operator's ~/.claude (settings, hooks, memory) out of agents. */
  claudeConfigDir: string;
  /** Per-run throwaway HOME, so ~/.ssh, ~/.gitconfig, ~/.config/gh are not where the agent looks. */
  homesDir: string;
  models: { cheap: string; standard: string; strong: string };
  claudeBin?: string;
  /** Wall clock for reading a rate-limit reset time. Absent: the system clock. */
  now?: () => Date;
  /**
   * The broker and scanner granted tools go through (architecture §5). Absent: the runner exposes no tools and
   * refuses a run with grants.
   */
  tools?: GrantedToolDeps;
}

/** A run's granted tools as the harness sees them: the bridge's MCP config and the tool names to allow. */
export interface BridgeArgs {
  mcpConfig: Record<string, unknown>;
  /** Granted broker tool names; each becomes `mcp__factory_tools__<name>` in `--allowedTools`. */
  tools: readonly string[];
}

/** The harness credential: the one secret the agent process holds (architecture §5). */
export interface HarnessCredential {
  name: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  value: string;
}

/**
 * The per-run toolchain homes (design 05-sandbox.md, issue #334): with a `toolchain` block, each tool's own cache
 * or home points into the run's TMPDIR (`<TMPDIR>/toolchain/<name>`), which the agent may already write, so a
 * build writes there and never into a shared cache. A `toolchain.env` entry may point one elsewhere (e.g. Gradle's
 * read-only `GRADLE_RO_DEP_CACHE` beside a per-run `GRADLE_USER_HOME`).
 */
export const TOOLCHAIN_HOMES: Readonly<Record<string, string>> = {
  npm_config_cache: "npm",
  CARGO_HOME: "cargo",
  PIP_CACHE_DIR: "pip",
  GRADLE_USER_HOME: "gradle",
};

/**
 * G1: the agent's whole environment, built from scratch. Nothing is inherited from the worker. With
 * `toolchain_env` (a `toolchain` block): the per-run toolchain homes, then its entries, each key checked again
 * here; the fixed entries below always win. Without it: exactly the environment before the block existed.
 */
export function buildAgentEnv(
  spec: Pick<AgentRunSpec, "env_allowlist" | "toolchain_env">,
  credential: HarnessCredential,
  paths: { home: string; claudeConfigDir: string; path: string },
): Record<string, string> {
  for (const key of Object.keys(spec.env_allowlist)) {
    if (FORBIDDEN_ENV.test(key)) throw new Error(`env_allowlist may not contain ${key} (G1)`);
  }
  const tmp = join(paths.home, "tmp");
  const toolchain = spec.toolchain_env;
  for (const key of Object.keys(toolchain ?? {})) {
    const refusal = toolchainEnvKeyRefusal(key);
    if (refusal) throw new Error(refusal);
  }
  const homes = Object.fromEntries(Object.entries(TOOLCHAIN_HOMES).map(([k, dir]) => [k, join(tmp, "toolchain", dir)]));
  return {
    ...(toolchain ? { ...homes, ...toolchain } : {}),
    ...spec.env_allowlist,
    PATH: paths.path,
    HOME: paths.home,
    TMPDIR: tmp,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    DISABLE_AUTOUPDATER: "1",
    // No global/system git config: no credential helper, so the agent cannot push on its own (G2).
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    [credential.name]: credential.value,
  };
}

/** Absolute path → Claude Code permission-rule path (`//` prefix = filesystem root). */
function rulePath(p: string): string {
  return p.startsWith("/") ? `/${p}` : p;
}

/**
 * Deny rules only the harness can enforce: the shared tools' guard covers file paths and `.env` files, but
 * Bash checks no commands and the shared module has no web tools, so these stay with this runner.
 */
const HARNESS_ONLY_DENY: readonly string[] = [
  "Bash(gh:*)",
  "Bash(security:*)",
  "Bash(git push:*)",
  "Bash(git credential:*)",
  "Bash(printenv:*)",
  "Bash(env)",
  "Bash(mysql:*)",
  "Bash(mysqldump:*)",
  "Bash(mysqladmin:*)",
  "WebFetch",
  "WebSearch",
];

/**
 * The shared guard's `.env` rule (src/core/tools/guard.ts) as Claude Code permission rules: `.env` and every
 * `.env.*` name except `.env.example`. Deny beats allow in Claude Code, so the exception has to be left out of
 * the deny globs. Claude Code matches them with the `ignore` package (2.1.316, case-insensitive), which has no
 * negated character class (`[!x]` and `[^x]` match `!`/`^` literally) but passes `[a-z]` ranges to the regex:
 *  - `.env.` plus a suffix of 0 to 6 characters, or of 8 or more;
 *  - a 7-character suffix (the length of `example`) that differs from `example` at position i: one glob per
 *    position, with a class of every character but that letter (both cases), `/` and control characters.
 * Left out: only `example` and its case variants (the same name to a case-insensitive matcher), and 7-character
 * suffixes holding a control character. The shared guard refuses all but the exact name `.env.example`.
 */
const allCharsBut = (letter: string): string => {
  const skip = [...new Set([0x2f, letter.toLowerCase().charCodeAt(0), letter.toUpperCase().charCodeAt(0)])].sort((a, b) => a - b);
  let cls = "";
  let from = 0x20;
  for (const code of skip) {
    if (from <= code - 1) cls += `${String.fromCharCode(from)}-${String.fromCharCode(code - 1)}`;
    from = code + 1;
  }
  return `[${cls}${String.fromCharCode(from)}-￿]`;
};
const ENV_EXAMPLE_SUFFIX = "example";
const ENV_FILE_GLOBS: readonly string[] = [
  ".env",
  ...[0, 1, 2, 3, 4, 5, 6].map((n) => `.env.${"?".repeat(n)}`),
  `.env.${"?".repeat(8)}*`,
  ...[...ENV_EXAMPLE_SUFFIX].map((c, i) => `.env.${"?".repeat(i)}${allCharsBut(c)}${"?".repeat(ENV_EXAMPLE_SUFFIX.length - 1 - i)}`),
];
export const ENV_FILE_DENY: readonly string[] = ["Read", "Edit"].flatMap((tool) => ENV_FILE_GLOBS.map((g) => `${tool}(**/${g})`));

/** The native tools whose writes are path-scoped: Claude Code's `Edit(...)` rules cover both Edit and Write. */
const PATH_SCOPED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write"]);

/**
 * G1 (subprocess scrub), G3 (OS sandbox denyRead), G4 (permission deny rules), and the write allow rules (design
 * §5 Sandbox): native Write and Edit are allowed only under the run folder (`workdir`) and `writable_paths`, the
 * roots `guardPolicy` gives the shared file tools, and under the runner's own temp folders (`tmp`, the run's
 * TMPDIR); one `Edit(//<root>/**)` rule each (Claude Code's Edit rules cover Write too). `--allowedTools` does
 * not name Write or Edit, and in `-p` mode a call no rule allows is refused, so a Write to any other path (the
 * owner's live checkout included) never runs. No `workdir`: no run folder rule. The paths come from
 * `guardPolicy`, the same policy the shared tools enforce. Relative entries resolve against `workdir`.
 *
 * Toolchain caches (`readable_paths`, design 05-sandbox.md): in `sandbox.filesystem.allowRead` (the OS read allow
 * list) and, so no write root can cover them, in `denyWrite` and an `Edit(//<cache>/**)` deny rule; never in
 * `allowWrite` or `permissions.allow`. A cache that overlaps a `deny_paths` entry is dropped here too (startup
 * already refuses it), so `allowRead` never reopens a denied folder. None: no key is added.
 *
 * Network: `allowLocalBinding` lets sandboxed commands bind and connect on localhost only, so tests that start a
 * local server (`listen 127.0.0.1:0`) run. No `allowedDomains` entry is added, so every other host stays denied
 * (in `-p` mode nobody can approve one). `npm_config_update_notifier=false` stops npm's own update check, which
 * otherwise asks registry.npmjs.org on every npm and npx call and is denied (docs/plugins/agent-runner.md).
 */
export function buildHarnessSettings(
  spec: Pick<AgentRunSpec, "deny_paths" | "writable_paths" | "readable_paths">,
  workdir?: string,
  tmp: readonly string[] = [],
): Record<string, unknown> {
  const policy = guardPolicy({
    workdir: workdir ?? "/", deny_paths: spec.deny_paths, writable_paths: spec.writable_paths, readable_paths: spec.readable_paths ?? [], env_allowlist: {},
  });
  const writeRoots = [...(workdir === undefined ? [] : [policy.workdir]), ...policy.writable_paths, ...tmp];
  const caches = policy.readable_paths.filter((c) => toolchainCacheOverlaps([c], policy.deny_paths).length === 0);
  return {
    env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", npm_config_update_notifier: "false" },
    permissions: {
      allow: writeRoots.map((r) => `Edit(${rulePath(r)}/**)`),
      deny: [
        ...policy.deny_paths.flatMap((p) => [`Read(${rulePath(p)})`, `Read(${rulePath(p)}/**)`]),
        ...caches.map((c) => `Edit(${rulePath(c)}/**)`),
        ...ENV_FILE_DENY,
        ...HARNESS_ONLY_DENY,
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...policy.deny_paths],
        allowWrite: [...policy.writable_paths],
        ...(caches.length > 0 ? { allowRead: [...caches], denyWrite: [...caches] } : {}),
      },
      network: { allowLocalBinding: true },
      credentials: {
        envVars: [
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
        ],
      },
    },
  };
}

/** A session id as Claude Code makes and accepts them. Nothing else reaches an argument or a file path. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session persistence (design §5 Pause): kept for implement, review and resolve runs that name a session
 * (`--session-id`, or `--resume` to continue a stored one on this host); off for every other call.
 */
function sessionArgs(spec: Pick<AgentRunSpec, "role" | "session">): string[] {
  const s = spec.session;
  if (!s || !SESSION_ROLES.includes(spec.role) || !SESSION_ID.test(s.id)) return ["--no-session-persistence"];
  return s.resume ? ["--resume", s.id] : ["--session-id", s.id];
}

/**
 * Builds the `claude -p` argument list. `tmp`: the run's temp folders, writable by Write and Edit (a rule only when
 * the spec offers one of them). `hooks`: the gate hooks' settings block, for the steps that get them. Exported for
 * tests.
 */
export function buildClaudeArgs(
  spec: AgentRunSpec,
  model: string,
  bin = "claude",
  bridge?: BridgeArgs,
  tmp: readonly string[] = [],
  hooks?: Record<string, unknown>,
): string[] {
  // Exactly the spec's tools, in its order: the runner adds none. Granted broker tools come only through the bridge.
  // Write and Edit are offered but allowed only by the settings' path-scoped rules, never as bare names.
  const tools = spec.tools.map((t) => t.name).join(",");
  const writes = spec.tools.some((t) => PATH_SCOPED_TOOLS.has(t.name));
  const allowed = [
    ...spec.tools.map((t) => t.name).filter((n) => !PATH_SCOPED_TOOLS.has(n)),
    ...(bridge?.tools ?? []).map(harnessToolName),
  ].join(",");
  return [
    bin,
    "-p",
    // Streamed events (one JSON object per line) so the runner sees progress during the run (stall detection,
    // design §5 Restarts); `--verbose` is required for stream-json in print mode. The last `result` event is
    // the same object `--output-format json` prints.
    "--output-format", "stream-json",
    "--verbose",
    "--settings", JSON.stringify({ ...buildHarnessSettings(spec, spec.sandbox?.workdir, writes ? tmp : []), ...(hooks ? { hooks } : {}) }),
    "--setting-sources", "project",
    "--strict-mcp-config",
    // The run's only MCP server, when it has granted tools: the bridge to the worker side (tool-bridge.ts).
    ...(bridge ? ["--mcp-config", JSON.stringify(bridge.mcpConfig)] : []),
    ...sessionArgs(spec),
    // Permission mode stays default: with the env scrub on, Claude Code forces it anyway. In -p mode,
    // anything outside --allowedTools is denied (no one can answer a prompt).
    "--tools", tools,
    ...(allowed ? ["--allowedTools", allowed] : []),
    "--model", model,
    "--append-system-prompt", spec.system_prompt,
    ...(spec.output_schema ? ["--json-schema", JSON.stringify(spec.output_schema)] : []),
  ];
}

export async function harnessCredential(secrets: SecretStore): Promise<HarnessCredential> {
  const oauth = await secrets.get(secretName("CLAUDE_CODE_OAUTH_TOKEN"));
  if (oauth) return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: oauth.reveal() };
  const key = await secrets.get(secretName("ANTHROPIC_API_KEY"));
  if (key) return { name: "ANTHROPIC_API_KEY", value: key.reveal() };
  throw new Error("no model credential in the secret file (docs/setup.md §3)");
}

export class ClaudeCodeRunner implements AgentRunner {
  constructor(private readonly opts: ClaudeCodeRunnerOptions) {}

  /** Exposes granted tools when it was given the broker and scanner they go through. */
  get exposes_tools(): boolean {
    return this.opts.tools !== undefined;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (spec.tool_grants.length === 0) return this.runWith(spec);
    const error = toolsNotExposedMessage(spec.tool_grants);
    if (!this.opts.tools) return { status: "failed", output: null, transcript: "", usage: NO_USAGE, error };
    // The run's socket: every call the bridge forwards (or anyone sends) passes the gate in this process.
    const gate = new ToolGate(this.opts.tools, spec);
    const bridge = await startBridgeHost(gate);
    try {
      return await this.runWith(spec, bridge);
    } finally {
      await bridge.close();
    }
  }

  /**
   * The gate hooks (design §4, issue #302), for an implement step the worker gave them to: the hook folder in the
   * harness config dir for the call, then the blocks it recorded on the result. Every other step runs as before.
   */
  private async runWith(spec: AgentRunSpec, bridge?: RunningBridge): Promise<AgentRunResult> {
    await mkdir(this.opts.claudeConfigDir, { recursive: true });
    const g = spec.gate_hooks;
    if (!g || !GATE_HOOK_ROLES.includes(spec.role)) return this.runClaude(spec, bridge);
    // Advisory: a host that cannot start (no folder, no socket) runs the step without hooks; the worker's gates decide.
    const hooks = await startGateHooks({
      dir: join(this.opts.claudeConfigDir, GATE_HOOKS_DIR, spec.run_id),
      spec: { ...spec, gate_hooks: g },
      sandbox: this.opts.sandbox,
      ...(this.opts.tools ? { scanner: this.opts.tools.scanner } : {}),
    }).catch(() => null);
    if (!hooks) return this.runClaude(spec, bridge);
    try {
      const result = await this.runClaude(spec, bridge, hooks);
      const blocks = await hooks.blocks();
      return blocks.length > 0 ? { ...result, gate_blocks: blocks } : result;
    } finally {
      await hooks.close();
    }
  }

  private async runClaude(spec: AgentRunSpec, bridge?: RunningBridge, hooks?: RunningGateHooks): Promise<AgentRunResult> {
    const home = join(this.opts.homesDir, spec.run_id);
    // The run's TMPDIR (buildAgentEnv): the one folder outside the run folder Write and Edit may also use.
    const tmp = join(home, "tmp");
    await mkdir(tmp, { recursive: true });

    const env = buildAgentEnv(spec, await harnessCredential(this.opts.secrets), {
      home,
      claudeConfigDir: this.opts.claudeConfigDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
    const model = this.opts.models[spec.model_class];
    const stallMs = spec.stall_ms ?? DEFAULT_STALL_MS;
    const firstOutputMs = spec.first_output_ms ?? DEFAULT_FIRST_OUTPUT_MS;
    const watch = new StallWatch(stallMs, firstOutputMs, hooks ? () => hooks.checking() : undefined);
    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      const bridgeArgs = bridge ? { mcpConfig: bridgeMcpConfig(bridge.socket), tools: spec.tool_grants } : undefined;
      result = await this.opts.sandbox.exec(spec.sandbox, buildClaudeArgs(spec, model, this.opts.claudeBin, bridgeArgs, [tmp], hooks?.settings), {
        env,
        stdin: spec.prompt,
        timeout_ms: spec.timeout_ms,
        signal: AbortSignal.any([spec.signal, watch.signal]),
        onStdout: (chunk) => watch.feed(chunk),
      });
    } finally {
      watch.stop();
    }

    // Usage is read whenever stdout holds the CLI's result event, also on timeout, stall and abort. A killed run
    // prints none: then the per-message usage its stream reported before the kill (design §5 Restarts).
    const parsed = parseJsonResult(result.stdout);
    const stream = streamFacts(result.stdout, new Set(spec.tools.filter((t) => t.capability !== "read").map((t) => t.name)));
    const usage = parsed ? usageOf(parsed) : stream.usage;
    const did_work = stream.did_work;
    if (spec.signal.aborted) return { status: "aborted", output: null, transcript: result.stdout, usage, did_work };
    if (watch.stalled) {
      const error = watch.stalled === "first_output"
        ? `no model output within first_output_ms (${firstOutputMs} ms)`
        : `no model output for stall_ms (${stallMs} ms) with no tool call open`;
      return { status: "stalled", output: null, transcript: result.stdout, usage, error, did_work };
    }
    if (result.timed_out) return { status: "timed_out", output: null, transcript: result.stdout, usage, did_work };

    if (parsed === null) {
      return {
        status: "failed",
        output: null,
        transcript: result.stdout + result.stderr,
        usage,
        error: `claude exited ${result.exit_code} without JSON output`,
        did_work,
      };
    }

    if (parsed.api_error_status === 429) {
      const text = typeof parsed.result === "string" ? parsed.result : "";
      const reset_at = parseRateLimitReset(text, (this.opts.now ?? (() => new Date()))());
      return {
        status: "rate_limited",
        output: null,
        transcript: result.stdout,
        usage,
        // The CLI's own text names when the limit resets (design §5 Restarts): kept, capped, for the failure detail.
        error: text.trim().slice(0, RATE_LIMIT_DETAIL_CHARS) || "rate_limited",
        did_work,
        ...(reset_at ? { reset_at } : {}),
      };
    }
    if (parsed.is_error || result.exit_code !== 0) {
      return { status: "failed", output: null, transcript: result.stdout, usage, error: parsed.subtype ?? "error", did_work };
    }
    return { status: "completed", output: parsed.structured_output ?? parsed.result, transcript: result.stdout, usage, did_work };
  }

  /** A stored session is `<CLAUDE_CONFIG_DIR>/projects/<folder key>/<id>.jsonl`; readable means resumable. */
  async hasSession(id: string): Promise<boolean> {
    for (const file of await this.sessionFiles(id)) {
      if (await access(file, constants.R_OK).then(() => true, () => false)) return true;
    }
    return false;
  }

  /** The session's transcript file and its side folder (`<id>/`), in every project folder. */
  async removeSession(id: string): Promise<void> {
    for (const file of await this.sessionFiles(id)) {
      await rm(file, { force: true });
      await rm(file.slice(0, -".jsonl".length), { recursive: true, force: true });
    }
  }

  private async sessionFiles(id: string): Promise<string[]> {
    if (!SESSION_ID.test(id)) return [];
    const projects = join(this.opts.claudeConfigDir, "projects");
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
    return dirs.filter((d) => d.isDirectory()).map((d) => join(projects, d.name, `${id}.jsonl`));
  }
}

/** The roles that get gate hooks when the spec has them: the worker gives them to the implement main and fix steps only. */
const GATE_HOOK_ROLES: readonly AgentRunSpec["role"][] = ["implement"];

const NO_USAGE: AgentRunResult["usage"] = { input_tokens: 0, output_tokens: 0, cost_usd: null };

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Per-model usage, keyed by model name. */
  modelUsage?: Record<string, { costUSD?: number; outputTokens?: number } | null>;
  /** HTTP status of the API error that ended the run; 429 is a usage or rate limit. */
  api_error_status?: number | null;
}

/** One JSON object, or null when `text` is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's result object on stdout, or null when stdout holds none: the last `result` event of the stream
 * (stream-json, one event per line), else stdout as one JSON object (the older `--output-format json`).
 */
function parseJsonResult(stdout: string): ClaudeJsonResult | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    const event = parseObject(line);
    if (event?.type === "result") return event as ClaudeJsonResult;
  }
  return parseObject(stdout) as ClaudeJsonResult | null;
}

/** The longest part of the CLI's rate-limit text a rate_limited result keeps as its error. */
const RATE_LIMIT_DETAIL_CHARS = 500;

/** The silence limit when the spec gives none (design §5 Restarts; `stall_ms` in factory.config.json). */
export const DEFAULT_STALL_MS = 300_000;

/** The first-output limit when the spec gives none (design §5 Restarts; `first_output_ms`, issue #215). */
export const DEFAULT_FIRST_OUTPUT_MS = 180_000;

/**
 * Stall detection over the CLI's streamed events (design §5 Restarts). Only model output restarts the clock:
 * an `assistant` event, a `thinking_tokens` system event (the model thinking), or a `tool_result` block. Other
 * system events (init, API retries) print before the model answers and are not activity (issue #215). Before the first model output the clock is the shorter of
 * `firstOutputMs` and `stallMs`, counted from the start; after it, `stallMs` from the last model output. Tool
 * calls are tracked from the events (`tool_use` blocks open one, `tool_result` blocks close it): while any is
 * open the clock does not run, since a test run in Bash can be silent for minutes; nor while `held` (a gate Stop
 * check running its commands); the run timeout still bounds both. Out of time: `signal` aborts, `stalled` says why.
 */
class StallWatch {
  private readonly ctl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly open = new Set<string>();
  private partial = "";
  private done = false;
  private seenModel = false;
  stalled: false | "first_output" | "silence" = false;

  constructor(private readonly ms: number, private readonly firstOutputMs: number, private readonly held = () => false) {
    this.arm();
  }

  get signal(): AbortSignal {
    return this.ctl.signal;
  }

  feed(chunk: string): void {
    if (this.done) return;
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    // A line longer than any event we care about is not kept whole: only its tool blocks matter, and an event
    // that large is mostly a tool result's content.
    if (this.partial.length > PARTIAL_LIMIT) this.partial = "";
    let model = false;
    for (const line of lines) if (this.track(line)) model = true;
    if (!model) return;
    this.seenModel = true;
    this.arm();
  }

  stop(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Tracks the line's tool blocks; true when it is model output (an assistant event or a tool result). */
  private track(line: string): boolean {
    const event = line.trim().startsWith("{") ? parseObject(line) : null;
    if (!event) return false;
    // A thinking-tokens event is the model working before it writes anything: activity, like an assistant event.
    let model = event.type === "assistant" || (event.type === "system" && event.subtype === "thinking_tokens");
    const message = event.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return model;
    for (const block of message.content as { type?: unknown; id?: unknown; tool_use_id?: unknown }[]) {
      if (block?.type === "tool_use" && typeof block.id === "string") this.open.add(block.id);
      if (block?.type === "tool_result") {
        model = true;
        if (typeof block.tool_use_id === "string") this.open.delete(block.tool_use_id);
      }
    }
    return model;
  }

  /** Restarts the clock when no tool call is open; stops it while one is. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.done || this.open.size > 0) return;
    const first = !this.seenModel && this.firstOutputMs <= this.ms;
    this.timer = setTimeout(() => {
      if (this.held()) return this.arm();
      this.stalled = first ? "first_output" : "silence";
      this.ctl.abort();
    }, first ? this.firstOutputMs : this.ms);
  }
}

/** Characters of an unfinished stdout line kept for tool tracking. */
const PARTIAL_LIMIT = 4 * 1024 * 1024;

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * Usage from the CLI's JSON result (design §6 Measurement): the four token counts, `total_cost_usd` (null when
 * absent), and the model. Several models in `modelUsage` (the CLI uses a small model for side tasks): the one
 * that cost the most, then the one that wrote the most output. No JSON: zeros and nulls.
 */
function usageOf(parsed: ClaudeJsonResult | null): Required<AgentRunResult["usage"]> {
  const u = parsed?.usage;
  const cost = parsed?.total_cost_usd;
  const models = Object.entries(parsed?.modelUsage ?? {});
  models.sort(([, a], [, b]) => count(b?.costUSD) - count(a?.costUSD) || count(b?.outputTokens) - count(a?.outputTokens));
  return {
    input_tokens: count(u?.input_tokens),
    output_tokens: count(u?.output_tokens),
    cache_read_tokens: count(u?.cache_read_input_tokens),
    cache_write_tokens: count(u?.cache_creation_input_tokens),
    cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    model: models[0]?.[0] ?? null,
  };
}

/**
 * What the stream says without a result event (design §5 Restarts): the usage of every `assistant` message,
 * counted once per message id (the CLI prints one event per content block, each with its message's usage; the
 * last one seen counts), with a null cost and the model that wrote the most output; and whether any `tool_use`
 * block named a write-capable tool (`writeTools`).
 */
function streamFacts(stdout: string, writeTools: ReadonlySet<string>): { usage: Required<AgentRunResult["usage"]>; did_work: boolean } {
  const messages = new Map<string, { usage: ClaudeJsonResult["usage"]; model: string | null }>();
  let did_work = false;
  for (const line of stdout.split("\n")) {
    // Cheap skip: only assistant events carry message usage and tool calls.
    if (!line.includes('"assistant"')) continue;
    const event = parseObject(line.trim());
    if (event?.type !== "assistant") continue;
    const message = event.message as { id?: unknown; model?: unknown; usage?: ClaudeJsonResult["usage"]; content?: unknown } | undefined;
    if (typeof message?.id === "string" && message.usage) {
      messages.set(message.id, { usage: message.usage, model: typeof message.model === "string" ? message.model : null });
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content as { type?: unknown; name?: unknown }[]) {
      if (block?.type === "tool_use" && typeof block.name === "string" && writeTools.has(block.name)) did_work = true;
    }
  }
  const usage = { ...NO_USAGE, cache_read_tokens: 0, cache_write_tokens: 0, model: null as string | null };
  const output = new Map<string, number>();
  for (const { usage: u, model } of messages.values()) {
    usage.input_tokens += count(u?.input_tokens);
    usage.output_tokens += count(u?.output_tokens);
    usage.cache_read_tokens += count(u?.cache_read_input_tokens);
    usage.cache_write_tokens += count(u?.cache_creation_input_tokens);
    if (model) output.set(model, (output.get(model) ?? 0) + count(u?.output_tokens));
  }
  usage.model = [...output].sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
  return { usage, did_work };
}

/**
 * The reset time in a Claude usage-limit message, as ISO-8601 UTC, or null if the text has none we can read.
 * Two forms: an epoch suffix (`...limit reached|1762000200`, seconds or ms), and a wall-clock time
 * (`resets 12:10pm`, optionally `(Area/City)`), read as its next occurrence after `now` in that zone (host
 * zone when none is given). Exported for tests.
 */
export function parseRateLimitReset(text: string, now: Date): string | null {
  const epoch = text.match(/\|\s*(\d{10}|\d{13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(epoch[1]!.length === 13 ? n : n * 1000).toISOString();
  }
  const m = text.match(/resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (minute > 59 || (ampm ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (ampm) hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  let wall: { h: number; m: number; s: number };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: m[4]?.trim(),
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    wall = { h: get("hour"), m: get("minute"), s: get("second") };
  } catch {
    return null; // unknown time zone
  }
  const nowMin = wall.h * 60 + wall.m;
  let ahead = (hour * 60 + minute - nowMin + 1440) % 1440;
  if (ahead === 0 && (wall.s > 0 || now.getUTCMilliseconds() > 0)) ahead = 1440;
  const start = now.getTime() - wall.s * 1000 - now.getUTCMilliseconds();
  return new Date(start + ahead * 60_000).toISOString();
}
