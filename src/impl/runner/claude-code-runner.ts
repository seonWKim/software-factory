import { access, constants, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FORBIDDEN_ENV, guardPolicy } from "../../core/tools/index.js";
import {
  type AgentRunResult, type AgentRunSpec, type AgentRunner, SESSION_ROLES, toolsNotExposedMessage,
} from "../../interfaces/agent-runner.js";
import type { Sandbox } from "../../interfaces/sandbox.js";
import { type SecretStore, secretName } from "../../interfaces/secret-store.js";
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

/** G1: the agent's whole environment, built from scratch. Nothing is inherited from the worker. */
export function buildAgentEnv(
  spec: Pick<AgentRunSpec, "env_allowlist">,
  credential: HarnessCredential,
  paths: { home: string; claudeConfigDir: string; path: string },
): Record<string, string> {
  for (const key of Object.keys(spec.env_allowlist)) {
    if (FORBIDDEN_ENV.test(key)) throw new Error(`env_allowlist may not contain ${key} (G1)`);
  }
  return {
    ...spec.env_allowlist,
    PATH: paths.path,
    HOME: paths.home,
    TMPDIR: join(paths.home, "tmp"),
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

/**
 * G1 (subprocess scrub), G3 (OS sandbox denyRead), G4 (permission deny rules). The paths come from
 * `guardPolicy`, the same policy the shared tools enforce. Relative entries resolve against `workdir`.
 *
 * Network: `allowLocalBinding` lets sandboxed commands bind and connect on localhost only, so tests that start a
 * local server (`listen 127.0.0.1:0`) run. No `allowedDomains` entry is added, so every other host stays denied
 * (in `-p` mode nobody can approve one). `npm_config_update_notifier=false` stops npm's own update check, which
 * otherwise asks registry.npmjs.org on every npm and npx call and is denied (docs/plugins/agent-runner.md).
 */
export function buildHarnessSettings(
  spec: Pick<AgentRunSpec, "deny_paths" | "writable_paths">,
  workdir = "/",
): Record<string, unknown> {
  const policy = guardPolicy({ workdir, deny_paths: spec.deny_paths, writable_paths: spec.writable_paths, env_allowlist: {} });
  return {
    env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", npm_config_update_notifier: "false" },
    permissions: {
      deny: [
        ...policy.deny_paths.flatMap((p) => [`Read(${rulePath(p)})`, `Read(${rulePath(p)}/**)`]),
        ...ENV_FILE_DENY,
        ...HARNESS_ONLY_DENY,
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...policy.deny_paths], allowWrite: [...policy.writable_paths] },
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

/** Builds the `claude -p` argument list. Exported for tests. */
export function buildClaudeArgs(spec: AgentRunSpec, model: string, bin = "claude", bridge?: BridgeArgs): string[] {
  // Exactly the spec's tools, in its order: the runner adds none. Granted broker tools come only through the bridge.
  const tools = spec.tools.map((t) => t.name).join(",");
  const allowed = [...spec.tools.map((t) => t.name), ...(bridge?.tools ?? []).map(harnessToolName)].join(",");
  return [
    bin,
    "-p",
    // Streamed events (one JSON object per line) so the runner sees progress during the run (stall detection,
    // design §5 Restarts); `--verbose` is required for stream-json in print mode. The last `result` event is
    // the same object `--output-format json` prints.
    "--output-format", "stream-json",
    "--verbose",
    "--settings", JSON.stringify(buildHarnessSettings(spec, spec.sandbox?.workdir)),
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

  private async runWith(spec: AgentRunSpec, bridge?: RunningBridge): Promise<AgentRunResult> {
    const home = join(this.opts.homesDir, spec.run_id);
    await mkdir(join(home, "tmp"), { recursive: true });
    await mkdir(this.opts.claudeConfigDir, { recursive: true });

    const env = buildAgentEnv(spec, await harnessCredential(this.opts.secrets), {
      home,
      claudeConfigDir: this.opts.claudeConfigDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
    const model = this.opts.models[spec.model_class];
    const stallMs = spec.stall_ms ?? DEFAULT_STALL_MS;
    const firstOutputMs = spec.first_output_ms ?? DEFAULT_FIRST_OUTPUT_MS;
    const watch = new StallWatch(stallMs, firstOutputMs);
    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      const bridgeArgs = bridge ? { mcpConfig: bridgeMcpConfig(bridge.socket), tools: spec.tool_grants } : undefined;
      result = await this.opts.sandbox.exec(spec.sandbox, buildClaudeArgs(spec, model, this.opts.claudeBin, bridgeArgs), {
        env,
        stdin: spec.prompt,
        timeout_ms: spec.timeout_ms,
        signal: AbortSignal.any([spec.signal, watch.signal]),
        onStdout: (chunk) => watch.feed(chunk),
      });
    } finally {
      watch.stop();
    }

    // Usage is read whenever stdout holds the CLI's result event, also on timeout, stall and abort.
    const parsed = parseJsonResult(result.stdout);
    const usage = usageOf(parsed);
    if (spec.signal.aborted) return { status: "aborted", output: null, transcript: result.stdout, usage };
    if (watch.stalled) {
      const error = watch.stalled === "first_output"
        ? `no model output within first_output_ms (${firstOutputMs} ms)`
        : `no model output for stall_ms (${stallMs} ms) with no tool call open`;
      return { status: "stalled", output: null, transcript: result.stdout, usage, error };
    }
    if (result.timed_out) return { status: "timed_out", output: null, transcript: result.stdout, usage };

    if (parsed === null) {
      return {
        status: "failed",
        output: null,
        transcript: result.stdout + result.stderr,
        usage,
        error: `claude exited ${result.exit_code} without JSON output`,
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
        ...(reset_at ? { reset_at } : {}),
      };
    }
    if (parsed.is_error || result.exit_code !== 0) {
      return { status: "failed", output: null, transcript: result.stdout, usage, error: parsed.subtype ?? "error" };
    }
    return { status: "completed", output: parsed.structured_output ?? parsed.result, transcript: result.stdout, usage };
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
export const RATE_LIMIT_DETAIL_CHARS = 500;

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
 * open the clock does not run, since a test run in Bash can be silent for minutes; a hung tool is still bounded
 * by the run timeout. When the clock runs out, `signal` aborts and `stalled` names which limit ran out.
 */
class StallWatch {
  private readonly ctl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly open = new Set<string>();
  private partial = "";
  private done = false;
  private seenModel = false;
  stalled: false | "first_output" | "silence" = false;

  constructor(
    private readonly ms: number,
    private readonly firstOutputMs: number,
  ) {
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
