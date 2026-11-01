import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FORBIDDEN_ENV, guardPolicy } from "../../core/tools/index.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../../interfaces/agent-runner.js";
import type { Sandbox } from "../../interfaces/sandbox.js";
import { type SecretStore, secretName } from "../../interfaces/secret-store.js";

export interface ClaudeCodeRunnerOptions {
  sandbox: Sandbox;
  secrets: SecretStore;
  /** CLAUDE_CONFIG_DIR for agent runs: keeps the operator's ~/.claude (settings, hooks, memory) out of agents. */
  claudeConfigDir: string;
  /** Per-run throwaway HOME, so ~/.ssh, ~/.gitconfig, ~/.config/gh are not where the agent looks. */
  homesDir: string;
  models: { cheap: string; strong: string };
  claudeBin?: string;
  /** Wall clock for reading a rate-limit reset time. Absent: the system clock. */
  now?: () => Date;
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

/** The shared guard's `.env` rule (src/core/tools/guard.ts) as Claude Code permission rules. */
const ENV_FILE_DENY: readonly string[] = ["Read(**/.env)", "Read(**/.env.*)"];

/**
 * G1 (subprocess scrub), G3 (OS sandbox denyRead), G4 (permission deny rules). The paths come from
 * `guardPolicy`, the same policy the shared tools enforce. Relative entries resolve against `workdir`.
 */
export function buildHarnessSettings(
  spec: Pick<AgentRunSpec, "deny_paths" | "writable_paths">,
  workdir = "/",
): Record<string, unknown> {
  const policy = guardPolicy({ workdir, deny_paths: spec.deny_paths, writable_paths: spec.writable_paths, env_allowlist: {} });
  return {
    env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
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
      credentials: {
        envVars: [
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
        ],
      },
    },
  };
}

/** Builds the `claude -p` argument list. Exported for tests. */
export function buildClaudeArgs(spec: AgentRunSpec, model: string, bin = "claude"): string[] {
  // Exactly the spec's tools, in its order: the runner adds none.
  const tools = spec.tools.map((t) => t.name).join(",");
  return [
    bin,
    "-p",
    "--output-format", "json",
    "--settings", JSON.stringify(buildHarnessSettings(spec, spec.sandbox?.workdir)),
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    // Permission mode stays default: with the env scrub on, Claude Code forces it anyway. In -p mode,
    // anything outside --allowedTools is denied (no one can answer a prompt).
    "--tools", tools,
    ...(tools ? ["--allowedTools", tools] : []),
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

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (spec.tool_grants.length > 0) throw new Error("broker tools inside agent runs are not supported yet");
    const home = join(this.opts.homesDir, spec.run_id);
    await mkdir(join(home, "tmp"), { recursive: true });
    await mkdir(this.opts.claudeConfigDir, { recursive: true });

    const env = buildAgentEnv(spec, await harnessCredential(this.opts.secrets), {
      home,
      claudeConfigDir: this.opts.claudeConfigDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
    const model = this.opts.models[spec.model_class];
    const result = await this.opts.sandbox.exec(spec.sandbox, buildClaudeArgs(spec, model, this.opts.claudeBin), {
      env,
      stdin: spec.prompt,
      timeout_ms: spec.timeout_ms,
      signal: spec.signal,
    });

    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: null as number | null };
    if (spec.signal.aborted) return { status: "aborted", output: null, transcript: result.stdout, usage };
    if (result.timed_out) return { status: "timed_out", output: null, transcript: result.stdout, usage };

    let parsed: ClaudeJsonResult;
    try {
      parsed = JSON.parse(result.stdout) as ClaudeJsonResult;
    } catch {
      return {
        status: "failed",
        output: null,
        transcript: result.stdout + result.stderr,
        usage,
        error: `claude exited ${result.exit_code} without JSON output`,
      };
    }
    usage.input_tokens = parsed.usage?.input_tokens ?? 0;
    usage.output_tokens = parsed.usage?.output_tokens ?? 0;
    usage.cost_usd = parsed.total_cost_usd ?? null;

    if (parsed.api_error_status === 429) {
      const reset_at = parseRateLimitReset(typeof parsed.result === "string" ? parsed.result : "", (this.opts.now ?? (() => new Date()))());
      return {
        status: "rate_limited",
        output: null,
        transcript: result.stdout,
        usage,
        error: "rate_limited",
        ...(reset_at ? { reset_at } : {}),
      };
    }
    if (parsed.is_error || result.exit_code !== 0) {
      return { status: "failed", output: null, transcript: result.stdout, usage, error: parsed.subtype ?? "error" };
    }
    return { status: "completed", output: parsed.structured_output ?? parsed.result, transcript: result.stdout, usage };
  }
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** HTTP status of the API error that ended the run; 429 is a usage or rate limit. */
  api_error_status?: number | null;
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
