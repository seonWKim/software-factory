// The pre-push checks (design §4, decided 2026-11-03): `repo.check_commands`, run in order before every push,
// stopping at the first failure. One list everywhere: the implement run before push and in its merge-conflict
// step, the update run on the merged branch, the resolve run after install.

import type { FactoryConfig } from "./config.js";
import { failingTests, stripAnsi } from "./output-summary.js";
import type { ExecResult, Sandbox, SandboxHandle } from "../interfaces/sandbox.js";

/**
 * The run failure code of an implement run whose checks failed twice (before and after its one fix step). A
 * task failure. Not the controller's `checks_failed` blocked reason for a failed PR check (design §5 CI gate):
 * same word, different thing; the two never meet in one table.
 */
export const CHECKS_FAILED_RUN = "checks_failed";

/**
 * The run failure code of an implement run whose check could not start its tools: a module under node_modules
 * or a tool binary is missing (issue #229). An infrastructure failure: the code cannot fix the host's install,
 * so the fix step is skipped and the retry does not spend a task attempt.
 */
export const TOOLCHAIN_MISSING = "toolchain_missing";

/**
 * Where the base rerun checks out the base commit (design §4): a temporary detached worktree inside the run
 * folder, so the same command finds the same dependencies as in the run folder and writes none of them.
 */
export const BASE_CHECKOUT_DIR = ".factory-base";

const SETUP_LINES = [
  // Node: a dependency the check imports is not installed where it looks.
  /Cannot find (?:module|package) ['"][^'"]*node_modules[^'"]*['"]/,
  // A tool binary the check runs is not there.
  /node_modules\/\.bin\/[\w.-]+[^\n]*(?:ENOENT|No such file|not found)/,
  /(?:ENOENT|No such file)[^\n]*node_modules\/\.bin\//,
  /(?:command not found|not found): (?:tsc|vitest|npx|node)\b/,
  /\b(?:tsc|vitest): (?:command )?not found/,
];

/** The first line of `text` that shows the check's tools are missing (see TOOLCHAIN_MISSING); null otherwise. */
export function toolchainMissing(text: string): string | null {
  for (const line of stripAnsi(text).split("\n")) {
    if (SETUP_LINES.some((re) => re.test(line))) return line.trim().slice(0, 300);
  }
  return null;
}

/** Characters of a failed check's output kept for the fix step's prompt and the outcome. */
export const CHECK_TAIL_CHARS = 2000;

/** What the text says in place of a redacted value. */
export const REDACTED = "[redacted]";

/** The check list: `repo.check_commands`, or `[repo.test_command]` when it is absent. */
export function checkCommands(repo: FactoryConfig["repo"]): string[][] {
  return repo.check_commands && repo.check_commands.length > 0 ? repo.check_commands.map((c) => [...c]) : [[...repo.test_command]];
}

/** The test files a check's output reports as failed (vitest's `FAIL  <file> > <name>` lines), in order, each once. */
export function failingTestFiles(text: string): string[] {
  return [...new Set(failingTests(text, Number.POSITIVE_INFINITY).map((t) => t.split(" > ")[0]!.trim()))];
}

/**
 * `cmd` run on `files` only, for the base rerun (design §4): npm needs `--` before arguments for the script;
 * a command that already has `--`, or any other runner, takes the files as they are.
 */
export function withTestFiles(cmd: readonly string[], files: readonly string[]): string[] {
  return cmd[0] === "npm" && !cmd.includes("--") ? [...cmd, "--", ...files] : [...cmd, ...files];
}

/** A command as it is shown in prompts, comments and the PR body. */
export function commandText(cmd: readonly string[]): string {
  return cmd.join(" ");
}

/** Every occurrence of every value replaced by REDACTED, longest value first. Empty values are skipped. */
export function redact(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].filter((x) => x !== "").sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
  return out;
}

export interface CheckResult {
  command: string[];
  ok: boolean;
  /** "passed", "exited 1", "timed out", "could not run: ...". */
  how: string;
  /** The last CHECK_TAIL_CHARS of stdout and stderr, redacted. Empty for a passing check. */
  tail: string;
}

export interface CheckRound {
  /** The commands that ran, in order; the last one is the failure, if any. */
  results: CheckResult[];
  failed: CheckResult | null;
}

export function exitText(r: Pick<ExecResult, "exit_code" | "signal" | "timed_out">): string {
  return r.timed_out ? "timed out" : `exited ${r.exit_code ?? r.signal ?? "abnormally"}`;
}

/**
 * Runs `commands` in order in the run folder (or `cwd` inside it), each with `env` and the run timeout, and stops at the first
 * failure. Output is redacted before it is kept: `redact` lists values that must never leave the worker.
 */
export async function runChecks(o: {
  sandbox: Sandbox;
  handle: SandboxHandle;
  commands: readonly (readonly string[])[];
  env: Record<string, string>;
  timeout_ms: number;
  signal: AbortSignal;
  redact: readonly string[];
  /** The folder to run in, relative to the run folder; absent: the run folder itself. */
  cwd?: string;
}): Promise<CheckRound> {
  const results: CheckResult[] = [];
  for (const cmd of o.commands) {
    let r: ExecResult;
    try {
      r = await o.sandbox.exec(o.handle, cmd, {
        env: o.env, timeout_ms: o.timeout_ms, signal: o.signal, ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
      });
    } catch (err) {
      const why = redact(err instanceof Error ? err.message : "unknown", o.redact).slice(0, 300);
      const failed = { command: [...cmd], ok: false, how: `could not run: ${why}`, tail: "" };
      results.push(failed);
      return { results, failed };
    }
    if (o.signal.aborted) return { results, failed: null };
    if (r.exit_code === 0 && !r.timed_out) {
      results.push({ command: [...cmd], ok: true, how: "passed", tail: "" });
      continue;
    }
    // The whole output is redacted before it is cut, so a value cut in half at the tail's start cannot slip through.
    const whole = redact(stripAnsi(`${r.stdout}${r.stderr}`), o.redact);
    const failed = { command: [...cmd], ok: false, how: exitText(r), tail: cutTail(whole, o.redact) };
    results.push(failed);
    return { results, failed };
  }
  return { results, failed: null };
}

/**
 * The last CHECK_TAIL_CHARS of already redacted text. If the cut leaves the end of a redacted value at the
 * start (the value began before the cut), that piece is redacted too; pieces under 3 characters are left.
 */
function cutTail(text: string, values: readonly string[]): string {
  if (text.length <= CHECK_TAIL_CHARS) return text;
  const tail = text.slice(-CHECK_TAIL_CHARS);
  for (const v of values) {
    for (let k = v.length - 1; k >= 3; k--) {
      if (tail.startsWith(v.slice(-k))) return `${REDACTED}${tail.slice(k)}`;
    }
  }
  return tail;
}

/**
 * The PR body's lines (design §4): one "Checked before push" line per command with its result.
 */
export function checkedLines(results: readonly CheckResult[], o: { fixed: boolean }): string[] {
  return results.map(
    (r) => `Checked before push: \`${commandText(r.command)}\` ${r.how}${o.fixed ? " (after one fix step)" : ""}`,
  );
}
