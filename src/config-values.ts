// The small parsers for factory.config.json values and supervisor env (moved out of compose.ts, RFC 0023 step 2e).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_STOP_CHECKS_DEFAULT, ALARM_DEFAULTS, STALL_DEFAULTS, type GateEntry, type StatsConfig, type ToolchainConfig, readOnlyFolders,
} from "./core/config.js";
import { gateListConfig } from "./core/checks.js";
import { toolchainEnvKeyRefusal } from "./core/tools/policy.js";
import type { CliIdentity } from "./core/local-cli.js";
import type { Tier, UserId, VerdictSeverity } from "./core/types.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";
import { positiveInteger } from "./core/settings.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import { type ChildRestart, type SupervisorStatus } from "./interfaces/updater.js";
import type { UiCommands } from "./ui/commands.js";
import type { FileConfig } from "./load-config.js";
import maxRestart from "./controller/settings/max-restart.setting.js"; import retryBase from "./controller/settings/retry-base-ms.setting.js"; import retryMax from "./controller/settings/retry-max-ms.setting.js";

/** SF_WORKER_INDEX_BASE as set by the supervisor: unset, empty or not a non-negative integer means 0. */
export function workerIndexBase(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 0;
  return Number.parseInt(value.trim(), 10);
}

/** `hooks` from factory.config.json: a list of hook names, or startup fails. */
export function hookNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("hooks must be a list of hook names");
  return value as string[];
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
 * of gate entries (gateListConfig, design 04-gate-commands: an argv, or `{ "dir": <folder>, "argv": [...] }`), or
 * startup fails naming the entry.
 */
export function checkCommandsConfig(value: unknown): { check_commands?: GateEntry[] } {
  const check_commands = gateListConfig("repo.check_commands", value, '["npm", "test"]');
  return check_commands ? { check_commands } : {};
}

/**
 * `repo.install_commands`: absent → nothing (the install step is `[install_command]`); otherwise a non-empty list of
 * gate entries run in order (gateListConfig), e.g. a Gradle install in `backend` and an npm install in `frontend`.
 */
export function installCommandsConfig(value: unknown): { install_commands?: GateEntry[] } {
  const install_commands = gateListConfig("repo.install_commands", value, '["npm", "ci"]');
  return install_commands ? { install_commands } : {};
}

/**
 * `toolchain` from factory.config.json (design 05-sandbox.md, issue #334): absent → undefined. Otherwise
 * `caches` is a list of absolute folders (a leading `~` is the owner's HOME), normalized, none overlapping a
 * `deny_paths` entry in either direction (so neither the secret file's folder nor the owner's config); `env` maps
 * env var names to strings, each key passing the G1 key check (`toolchainEnvKeyRefusal`); `warm_command` is argv,
 * absent: `install_command`. Every problem fails startup at once, one per line, each naming its entry. The values
 * are scanned for secrets in build(), by the configured scanner (`checkToolchainEnv`).
 */
export function toolchainConfig(
  raw: unknown,
  ctx: { home: string; install_command: readonly string[]; deny_paths: readonly string[] },
): ToolchainConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("toolchain must be an object with caches, env and warm_command");
  const problems: string[] = [];
  const caches = readOnlyFolders("toolchain.caches", raw.caches ?? [], { expand: expandHome(ctx.home), deny_paths: ctx.deny_paths }, problems);
  const env: Record<string, string> = {};
  if (raw.env !== undefined && !isRecord(raw.env)) problems.push("toolchain.env must be an object of env var names to strings");
  for (const [key, value] of Object.entries(isRecord(raw.env) ? raw.env : {})) {
    const refusal = toolchainEnvKeyRefusal(key);
    if (refusal) problems.push(refusal);
    else if (typeof value !== "string") problems.push(`toolchain.env.${key} must be a string`);
    else env[key] = value;
  }
  let warm_command: string[] = [...ctx.install_command];
  try {
    warm_command = argvConfig("toolchain.warm_command", raw.warm_command, ctx.install_command);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { caches, env, warm_command };
}

/** A configured path with a leading `~` taken as the owner's HOME (no HOME: unchanged, so it fails as relative). */
export const expandHome = (home: string) => (p: string): string => ((p === "~" || p.startsWith("~/")) && home !== "" ? join(home, p.slice(1)) : p);

/**
 * G1 on the toolchain's env values at startup: each value goes through the configured egress scanner (known
 * secret values and secret patterns), so a token pasted into `toolchain.env` never reaches an agent. Fails naming
 * the entry and the rule, never the value. No block, or no entry: nothing is scanned.
 */
export async function checkToolchainEnv(toolchain: ToolchainConfig | undefined, scanner: EgressScanner): Promise<void> {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(toolchain?.env ?? {})) {
    const scan = await scanner.scan("log", value);
    if (!scan.clean) problems.push(`toolchain.env.${key} looks like a credential (${scan.findings.map((f) => f.rule).join(", ")}) (G1)`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** A gate command from config: absent → `fallback`; otherwise a non-empty argv of non-empty strings, or startup fails. */
export function argvConfig(key: string, value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v !== "")) {
    throw new Error(`${key} must be a non-empty array of non-empty strings (argv), e.g. ${JSON.stringify(fallback)}`);
  }
  return [...(value as string[])];
}

/** The retry keys (design §5 Restarts) with their setting files' defaults (`auth_pause_ms`: `retry_max_ms`). Positive integers,
 * base ≤ max, or startup fails. */
export function retryConfig(file: Pick<FileConfig, "max_restart" | "retry_base_ms" | "retry_max_ms" | "auth_pause_ms">) {
  const retry_max_ms = file.retry_max_ms ?? retryMax.default!;
  const r = {
    max_restart: file.max_restart ?? maxRestart.default!,
    retry_base_ms: file.retry_base_ms ?? retryBase.default!,
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

export function isTier(n: number): n is Tier {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
