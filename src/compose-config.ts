// The plain config parsers and checks (moved from compose.ts, the composition root, which re-exports them).
// Guard and gate checks (toolchainConfig, checkToolchainEnv, checkEnabledHooks, hookNames) stay in compose.ts.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AGENT_STOP_CHECKS_DEFAULT, ALARM_DEFAULTS, type FactoryConfig, STALL_DEFAULTS, type StatsConfig, type ToolchainConfig, uiCheckSentence } from "./core/config.js";
import { checkCommands, commandText } from "./core/checks.js";
import { type SplitLimits, splitThresholds } from "./core/split.js";
import type { CliIdentity } from "./core/local-cli.js";
import type { UserId, VerdictSeverity } from "./core/types.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";
import { BUILT_IN_SETTINGS, positiveInteger } from "./core/settings.js";
import { CONFIG_ENV, type ChildRestart, type SupervisorStatus } from "./interfaces/updater.js";
import type { UiCommands } from "./ui/commands.js";
import type { FileConfig } from "./compose-file.js";

/**
 * The config path for this process, parsed once at startup for every command: `--config <path>` (or
 * `--config=<path>`) anywhere in `argv`, else FACTORY_CONFIG, made absolute against `cwd`. `args` is `argv`
 * without the flag. No flag and no env var: `configFile` is undefined (the code root's checked-in file).
 */
export function cliConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): { args: string[]; configFile: string | undefined } {
  const args: string[] = [];
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a.startsWith("--config=")) {
      const value = a === "--config" ? argv[++i] : a.slice("--config=".length);
      if (!value) throw new Error("--config needs a path to a factory.config.json");
      flag = value;
    } else args.push(a);
  }
  const chosen = flag ?? (env[CONFIG_ENV] || undefined);
  return { args, configFile: chosen === undefined ? undefined : resolve(cwd, chosen) };
}

/** The placeholder in prompts/*.md that names the project's pre-push checks. */
export const CHECK_COMMANDS_PLACEHOLDER = "{{check_commands}}";
/** The placeholder in prompts/*.md that names where a change lives: the forge plugin, or "local" with none. */
export const FORGE_PLACEHOLDER = "{{forge}}";
export const TOOLCHAIN_PLACEHOLDER = "{{toolchain}}"; // the toolchain sentence (design 05-sandbox.md): empty with no toolchain block
export const UI_CHECK_PLACEHOLDER = "{{ui_check}}"; // the UI check sentence (uiCheckSentence): empty with no repo.ui_check
export const SPLIT_PLACEHOLDERS = ["{{max_diff_lines}}", "{{max_diff_files}}", "{{split_lines}}", "{{split_files}}"] as const;

/**
 * A prompt file's text with its placeholders filled, once at load: the check commands, each command of
 * `checkCommands` (so `repo.check_commands`, else `test_command`) in backticks, in order; the forge name
 * (`plugins.forge`, else "local"); the `toolchain` block's offline sentence; the `repo.ui_check` sentence (none: "");
 * SPLIT_PLACEHOLDERS: the size caps `limits` (the configured project's max_diff_lines, max_diff_files), then their split thresholds.
 */
export function fillPrompt(text: string, repo: FactoryConfig["repo"], forge: string, toolchain?: ToolchainConfig, limits: SplitLimits = BUILT_IN_SETTINGS): string {
  const t = splitThresholds(limits), sizes = [limits.max_diff_lines, limits.max_diff_files, t.lines, t.files];
  const checks = checkCommands(repo).map((c) => `\`${commandText(c)}\``).join(", then ");
  const caches = toolchain && toolchain.caches.length > 0 ? ` (${toolchain.caches.map((c) => `\`${c}\``).join(", ")})` : "";
  const offline = toolchain ? ` They run offline: there is no network, and the toolchain caches${caches} are read-only, so build from what they hold and never write to or download into them.` : "";
  return SPLIT_PLACEHOLDERS.reduce((out, p, i) => out.split(p).join(String(sizes[i])), text).split(CHECK_COMMANDS_PLACEHOLDER).join(checks).split(FORGE_PLACEHOLDER).join(forge).split(TOOLCHAIN_PLACEHOLDER).join(offline).split(UI_CHECK_PLACEHOLDER).join(uiCheckSentence(repo.ui_check));
}

/** SF_WORKER_INDEX_BASE as set by the supervisor: unset, empty or not a non-negative integer means 0. */
export function workerIndexBase(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 0;
  return Number.parseInt(value.trim(), 10);
}

/** SF_CODE_VERSION as set by the supervisor: the revision, trimmed; unset or blank: none (the worker stamps `dev`). */
export function codeVersion(value: string | undefined): { code_version?: string } {
  const rev = value?.trim();
  return rev ? { code_version: rev } : {};
}

export const DEFAULT_UI_PORT = 4310;

/** `ui.port` from factory.config.json: absent means 4310, otherwise an integer 1–65535 or startup fails. */
export function uiPort(ui: FileConfig["ui"]): number {
  const port = ui?.port;
  if (port === undefined) return DEFAULT_UI_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ui.port must be an integer from 1 to 65535");
  }
  return port;
}

/**
 * `ui.user_id` from factory.config.json: absent means null (uiCommandsActor decides), otherwise a
 * non-empty string (a factory user ID, never a display name) or startup fails naming the key.
 */
export function uiUserId(ui: FileConfig["ui"]): UserId | null {
  const id: unknown = ui?.user_id;
  if (id === undefined) return null;
  if (typeof id !== "string" || id.trim() === "") throw new Error("ui.user_id must be a non-empty string (a factory user ID)");
  return id.trim() as UserId;
}

/** True for a loopback bind address: only this machine's user can reach the server. */
export function isLoopback(bind: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(bind.trim().toLowerCase());
}

/**
 * Who the page's commands act as (design 09, 2026-11-08): `ui.user_id` when set (source `config`); else, on a
 * loopback server, the CLI identity of this machine (`cli_user` is `config`, git user.email or the OS user is
 * `environment`), so a solo setup needs no key. A server on any other address needs `ui.user_id`: null.
 * Commands are then authorized as any command is (the owner check; `local:anonymous` is never the owner).
 */
export function uiCommandsActor(uiUser: UserId | null, cli: CliIdentity, bind: string): Pick<UiCommands, "actor" | "source"> {
  if (uiUser !== null) return { actor: uiUser, source: "config" };
  if (!isLoopback(bind)) return { actor: null, source: null };
  return { actor: cli.user, source: cli.from === "cli_user" ? "config" : "environment" };
}

export const STATS_MIN_SAMPLE_DEFAULT = 10;

/**
 * The `stats` key (design §6): every severity needs a weight that is a finite number ≥ 0, and `min_sample`
 * (absent: 10) is an integer ≥ 1, or startup fails. There are no default weights.
 */
export function statsConfig(raw: FileConfig["stats"]): StatsConfig {
  const weights = raw?.weights;
  if (typeof weights !== "object" || weights === null || Array.isArray(weights)) {
    throw new Error(`stats.weights must be an object with a weight for each of ${VERDICT_SEVERITIES.join(", ")}`);
  }
  const w = weights as Record<string, unknown>;
  const checked = {} as Record<VerdictSeverity, number>;
  for (const s of VERDICT_SEVERITIES) {
    const v = w[s];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`stats.weights.${s} must be a number ≥ 0`);
    checked[s] = v;
  }
  const min_sample = raw?.min_sample === undefined ? STATS_MIN_SAMPLE_DEFAULT : raw.min_sample;
  if (typeof min_sample !== "number" || !Number.isInteger(min_sample) || min_sample < 1) {
    throw new Error("stats.min_sample must be an integer ≥ 1");
  }
  return { weights: checked, min_sample };
}

/** Absent: ["npm", "test"]. Otherwise a non-empty argv of non-empty strings, or startup fails. */
export function testCommand(value: unknown): string[] {
  return argvConfig("repo.test_command", value, ["npm", "test"]);
}

/**
 * `repo.check_commands`: absent → nothing (the core falls back to `[test_command]`); otherwise a non-empty list
 * of argv, each a non-empty array of non-empty strings, or startup fails.
 */
export function checkCommandsConfig(value: unknown): { check_commands?: string[][] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('repo.check_commands must be a non-empty list of argv, e.g. [["npm", "run", "typecheck"], ["npm", "test"]]');
  }
  return { check_commands: value.map((v, i) => argvConfig(`repo.check_commands[${i}]`, v, ["npm", "test"])) };
}

/** A gate command from config: absent → `fallback`; otherwise a non-empty argv of non-empty strings, or startup fails. */
export function argvConfig(key: string, value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v !== "")) {
    throw new Error(`${key} must be a non-empty array of non-empty strings (argv), e.g. ${JSON.stringify(fallback)}`);
  }
  return [...(value as string[])];
}

export const RETRY_DEFAULTS = { max_restart: 3, retry_base_ms: 60_000, retry_max_ms: 1_800_000 } as const;

/** The retry keys (design §5 Restarts) with their defaults (`auth_pause_ms`: `retry_max_ms`). Positive integers,
 * base ≤ max, or startup fails. */
export function retryConfig(file: Pick<FileConfig, "max_restart" | "retry_base_ms" | "retry_max_ms" | "auth_pause_ms">) {
  const retry_max_ms = file.retry_max_ms ?? RETRY_DEFAULTS.retry_max_ms;
  const r = {
    max_restart: file.max_restart ?? RETRY_DEFAULTS.max_restart,
    retry_base_ms: file.retry_base_ms ?? RETRY_DEFAULTS.retry_base_ms,
    retry_max_ms,
    auth_pause_ms: file.auth_pause_ms === undefined ? retry_max_ms : file.auth_pause_ms, // an explicit null fails below
  };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
  }
  if (r.retry_base_ms > r.retry_max_ms) throw new Error("retry_base_ms must not exceed retry_max_ms");
  return r;
}

/**
 * `stall_ms`, `first_output_ms` and `probe_interval_ms` (design §5 Restarts) with their defaults
 * (STALL_DEFAULTS): positive integers, or startup fails.
 */
export function stallConfig(
  file: Pick<FileConfig, "stall_ms" | "first_output_ms" | "probe_interval_ms">,
): { stall_ms: number; first_output_ms: number; probe_interval_ms: number } {
  const r = {
    stall_ms: file.stall_ms === undefined ? STALL_DEFAULTS.stall_ms : file.stall_ms,
    first_output_ms: file.first_output_ms === undefined ? STALL_DEFAULTS.first_output_ms : file.first_output_ms,
    probe_interval_ms: file.probe_interval_ms === undefined ? STALL_DEFAULTS.probe_interval_ms : file.probe_interval_ms,
  };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
  }
  return r;
}

/**
 * The restart list of the supervisor status file (design 05-alarms). No file (not supervised, or the `none`
 * updater), one that does not parse, or one from before the list existed: none.
 */
export async function readRestarts(file: string): Promise<ChildRestart[]> {
  try {
    const status = JSON.parse(await readFile(file, "utf8")) as Partial<SupervisorStatus>;
    return Array.isArray(status.restarts) ? status.restarts : [];
  } catch {
    return [];
  }
}

/** The alarm keys (design 05-alarms) with their defaults (ALARM_DEFAULTS): positive integers, or startup fails. */
export function alarmConfig(
  file: Pick<FileConfig, "alarm_repeat_count" | "alarm_window_minutes" | "alarm_restart_count">,
): { alarm_repeat_count: number; alarm_window_minutes: number; alarm_restart_count: number } {
  return {
    alarm_repeat_count: positiveInteger("alarm_repeat_count", file.alarm_repeat_count ?? ALARM_DEFAULTS.alarm_repeat_count),
    alarm_window_minutes: positiveInteger("alarm_window_minutes", file.alarm_window_minutes ?? ALARM_DEFAULTS.alarm_window_minutes),
    alarm_restart_count: positiveInteger("alarm_restart_count", file.alarm_restart_count ?? ALARM_DEFAULTS.alarm_restart_count),
  };
}

/** `agent_stop_checks` (design §4 Pre-push gates): absent means 3, otherwise a positive integer or startup fails. */
export function agentStopChecks(file: Pick<FileConfig, "agent_stop_checks">): number {
  const v = file.agent_stop_checks;
  if (v === undefined) return AGENT_STOP_CHECKS_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("agent_stop_checks must be a positive integer");
  return v;
}

/** The deepest speculative merge queue: each level is one more merge-check run out at once. */
export const MERGE_QUEUE_DEPTH_MAX = 10;

/** `merge_queue.depth`: absent means 1 (solo: one check at a time), otherwise 1 to MERGE_QUEUE_DEPTH_MAX or startup fails. */
export function mergeQueueDepth(file: Pick<FileConfig, "merge_queue">): number {
  const v = file.merge_queue?.depth;
  if (v === undefined) return 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MERGE_QUEUE_DEPTH_MAX) {
    throw new Error(`merge_queue.depth must be an integer from 1 to ${MERGE_QUEUE_DEPTH_MAX}`);
  }
  return v;
}
