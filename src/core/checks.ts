// The pre-push checks (design §4, decided 2026-11-03): `repo.check_commands`, run in order before every push,
// stopping at the first failure. One list everywhere: the implement run before push and in its merge-conflict
// step, the update run on the merged branch, the resolve run after install.

import type { FactoryConfig } from "./config.js";
import { failingTests, stripAnsi } from "./output-summary.js";
import { type SelectionMode, type SelectionRecord, type TestSelection, noteSelection, selectTests, selectionMode, uncovered } from "./test-selection.js";
import type { TrustedGit } from "./pre-push.js";
import { type DoneCheck, closestTestFile } from "./done-checks.js";
import type { RunId, StateChangeDetail } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { ExecResult, Sandbox, SandboxHandle } from "../interfaces/sandbox.js";

// The merge-check run gets it through the runner's check tools, as the other check helpers (worker/runner.ts).
export { mergeMiss } from "./test-selection.js";

/**
 * The run failure code of an implement run whose checks failed twice (before and after its one fix step). A
 * task failure. Not the controller's `checks_failed` blocked reason for a failed PR check (design §5 CI gate):
 * same word, different thing; the two never meet in one table.
 */
export const CHECKS_FAILED_RUN = "checks_failed";

/**
 * The run failure code of an implement run whose check could not start its tools: a module under node_modules
 * or a tool binary is missing (issue #229), or the JDK or Gradle is missing. An infrastructure failure: the code cannot fix the host's install,
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
  // JDK and Gradle: no JDK configured, a build tool binary missing, or a Gradle wrapper that cannot run. The
  // name starts the line or follows a space, `/` or `:`, so `Main.java: not found` is not read as one.
  /JAVA_HOME is not set/,
  /(?:command not found|not found): (?:\S*\/)?(?:gradlew?|javac?)\b/,
  /(?:^|[\s/:])(?:gradlew?|javac?): (?:command )?not found/,
  /(?:^|[\s/:])gradlew: Permission denied/,
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

/**
 * A gate command entry as factory.config.json writes it (design 04-gate-commands): a plain argv, run in the run
 * folder, or `{ "dir": <folder>, "argv": [...] }`, run in that folder inside the run folder. Never a shell string.
 */
export type GateEntry = readonly string[] | { readonly dir: string; readonly argv: readonly string[] };

/** A gate entry's argv (design 04-gate-commands). */
export const gateArgv = (e: GateEntry): readonly string[] => ("argv" in e ? e.argv : e);

/** A gate entry's folder inside the run folder; undefined: the run folder itself. */
export const gateDir = (e: GateEntry): string | undefined => ("dir" in e ? e.dir : undefined);

/** `e`'s folder with `argv`: a plain argv when `e` has no folder. */
function withArgv(e: GateEntry, argv: string[]): GateEntry {
  const dir = gateDir(e);
  return dir === undefined ? argv : { dir, argv };
}

const copyEntry = (e: GateEntry): GateEntry => withArgv(e, [...gateArgv(e)]);

/** What a check result records of the entry it ran (the inverse of ranEntry). */
export function ranFields(e: GateEntry): Pick<CheckResult, "command" | "dir"> {
  const dir = gateDir(e);
  return { command: [...gateArgv(e)], ...(dir === undefined ? {} : { dir }) };
}

/** The entry a check result ran: its argv, in its folder when it had one. */
export const ranEntry = (r: Pick<CheckResult, "command" | "dir">): GateEntry => (r.dir === undefined ? r.command : { dir: r.dir, argv: r.command });

export const nonEmptyStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");

/** `dir` as a folder inside the run folder, `/`-separated with no `.` or empty part ("" is the run folder itself); null when absolute or above it. */
function insideRunFolder(dir: string): string | null {
  if (/^([/\\]|[A-Za-z]:)/.test(dir)) return null;
  const out: string[] = [];
  for (const seg of dir.split(/[/\\]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (out.pop() === undefined) return null;
  }
  return out.join("/");
}

/**
 * One gate entry from config (the one parser of `repo.install_commands`, `repo.check_commands` and
 * `repo.ui_check.command`): a non-empty argv of non-empty strings, or an object with only `dir`, a non-empty folder
 * inside the run folder (not absolute, not above it via `..`), and `argv`, such an argv. Anything else fails startup
 * naming `key`. A `dir` that is the run folder itself (`.`) gives the plain argv. `example` is an argv, as JSON.
 */
export function gateEntryConfig(key: string, value: unknown, example: string): GateEntry {
  if (nonEmptyStrings(value)) return [...value];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an argv (a non-empty array of non-empty strings, no shell) or { "dir": <folder>, "argv": [...] }, e.g. ${example} or { "dir": "frontend", "argv": ${example} }`);
  }
  const { dir, argv, ...rest } = value as { dir?: unknown; argv?: unknown };
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`${key} has unknown keys ${extra.join(", ")}; valid keys: dir, argv`);
  const folder = typeof dir === "string" && dir.trim() !== "" ? insideRunFolder(dir) : null;
  if (folder === null) throw new Error(`${key}.dir must be a non-empty folder inside the run folder (relative, not above it), e.g. "frontend"`);
  if (!nonEmptyStrings(argv)) throw new Error(`${key}.argv must be a non-empty array of non-empty strings (argv, no shell), e.g. ${example}`);
  return folder === "" ? [...argv] : { dir: folder, argv: [...argv] };
}

/** A list of gate entries from config: absent → undefined; otherwise a non-empty list, each checked by gateEntryConfig as `key[i]`. */
export function gateListConfig(key: string, value: unknown, example: string): GateEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty list of gate commands, each an argv or { "dir": <folder>, "argv": [...] }, e.g. [${example}, { "dir": "frontend", "argv": ${example} }]`);
  }
  return value.map((v, i) => gateEntryConfig(`${key}[${i}]`, v, example));
}

/** The check list: `repo.check_commands`, or `[repo.test_command]` when it is absent. */
export function checkCommands(repo: FactoryConfig["repo"]): GateEntry[] {
  return repo.check_commands && repo.check_commands.length > 0 ? repo.check_commands.map(copyEntry) : [[...repo.test_command]];
}

/**
 * The install step (design 04-gate-commands): `run` on `repo.install_commands` in order, each in its folder, as they
 * are; absent: `run` on `[repo.install_command]` through `cache`, the run-side install cache (src/worker/install-cache.ts),
 * which stands in only for that one command. Null: the cache stood in for the install.
 */
export function installStep<R>(
  repo: Pick<FactoryConfig["repo"], "install_command" | "install_commands">, run: (commands: GateEntry[]) => Promise<R>,
  cache: (install: () => Promise<R>) => Promise<R | null>,
): Promise<R | null> {
  return repo.install_commands ? run(repo.install_commands.map(copyEntry)) : cache(() => run([[...repo.install_command]]));
}

/** The test files a check's output reports as failed (vitest's `FAIL  <file> > <name>` lines), in order, each once. */
export function failingTestFiles(text: string): string[] {
  return [...new Set(failingTests(text, Number.POSITIVE_INFINITY).map((t) => t.split(" > ")[0]!.trim()))];
}

/**
 * `cmd` run on `files` only, for the base rerun (design §4): npm needs `--` before arguments for the script;
 * a command that already has `--`, or any other runner, takes the files as they are.
 */
export function withTestFiles(cmd: readonly string[], files: readonly string[]): string[];
export function withTestFiles(cmd: GateEntry, files: readonly string[]): GateEntry;
export function withTestFiles(cmd: GateEntry, files: readonly string[]): GateEntry {
  const argv = gateArgv(cmd);
  return withArgv(cmd, argv[0] === "npm" && !argv.includes("--") ? [...argv, "--", ...files] : [...argv, ...files]);
}

/** A command as it is shown in prompts, comments and the PR body; a folder entry adds `(in <dir>/)`. */
export function commandText(cmd: GateEntry): string {
  const dir = gateDir(cmd);
  return `${gateArgv(cmd).join(" ")}${dir === undefined ? "" : ` (in ${dir}/)`}`;
}

/** Every occurrence of every value replaced by REDACTED, longest value first. Empty values are skipped. */
export function redact(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].filter((x) => x !== "").sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
  return out;
}

export interface CheckResult {
  /** The argv that ran. */
  command: string[];
  /** Its entry's folder inside the run folder (a `{ dir, argv }` entry); absent: the run folder. */
  dir?: string;
  ok: boolean;
  /** "passed", "exited 1", "timed out", "could not run: ...". */
  how: string;
  /** The last CHECK_TAIL_CHARS of stdout and stderr, redacted. Empty for a passing check. */
  tail: string;
  /** The done-when lines this command checks (doneCheckRound); absent: none. */
  lines?: string[];
  /** A test file check whose file does not exist (doneCheckRound's `missing`): the file, and the closest existing one by name. */
  missing?: { file: string; closest: string | null };
}

/** The outcome of a test file check whose file does not exist (design 04-pre-push-gates), in place of its exit code. */
const missingTestFileText = (file: string): string => `the check names ${file}, which does not exist`;

export interface CheckRound {
  /** The commands that ran, in order; the last one is the failure, if any. */
  results: CheckResult[];
  failed: CheckResult | null;
}

export function exitText(r: Pick<ExecResult, "exit_code" | "signal" | "timed_out">): string {
  return r.timed_out ? "timed out" : `exited ${r.exit_code ?? r.signal ?? "abnormally"}`;
}

/**
 * Runs `commands` in order, each in its own folder (a `{ dir, argv }` entry: `dir`; a plain argv: the run folder; both
 * inside `cwd` when it is given), each with `env` and the run timeout, without a shell, and stops at the first failure.
 * Output is redacted before it is kept: `redact` lists values that must never leave the worker.
 */
export async function runChecks(o: {
  sandbox: Sandbox;
  handle: SandboxHandle;
  commands: readonly GateEntry[];
  env: Record<string, string>;
  timeout_ms: number;
  signal: AbortSignal;
  redact: readonly string[];
  /** The folder every command's folder is in, relative to the run folder; absent: the run folder itself. */
  cwd?: string;
}): Promise<CheckRound> {
  const results: CheckResult[] = [];
  for (const entry of o.commands) {
    const ran = ranFields(entry);
    const dir = ran.dir;
    const cwd = dir === undefined ? o.cwd : o.cwd === undefined ? dir : `${o.cwd}/${dir}`;
    let r: ExecResult;
    try {
      r = await o.sandbox.exec(o.handle, [...ran.command], {
        env: o.env, timeout_ms: o.timeout_ms, signal: o.signal, ...(cwd === undefined ? {} : { cwd }),
      });
    } catch (err) {
      const why = redact(err instanceof Error ? err.message : "unknown", o.redact).slice(0, 300);
      const failed = { ...ran, ok: false, how: `could not run: ${why}`, tail: "" };
      results.push(failed);
      return { results, failed };
    }
    if (o.signal.aborted) return { results, failed: null };
    if (r.exit_code === 0 && !r.timed_out) {
      results.push({ ...ran, ok: true, how: "passed", tail: "" });
      continue;
    }
    // The whole output is redacted before it is cut, so a value cut in half at the tail's start cannot slip through.
    const whole = redact(stripAnsi(`${r.stdout}${r.stderr}`), o.redact);
    const failed = { ...ran, ok: false, how: exitText(r), tail: cutTail(whole, o.redact) };
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
    (r) => `Checked before push: \`${commandText(ranEntry(r))}\` ${r.how}${o.fixed ? " (after one fix step)" : ""}`,
  );
}

/**
 * `commands` with the one whose argv equals `repo.test_command` run on the selected files only in enforce mode (appended
 * as the base rerun appends them, withTestFiles); every other command, typecheck included, runs whole, and in shadow
 * mode every command does. No `repo.test_selection`: `commands` as they are, no selection. The selection, its mode and
 * its reason go to `log` before any command runs, then one line per test picked by a read; a selection that cannot be made (git failed) is full.
 */
export async function selectedChecks(
  repo: Pick<FactoryConfig["repo"], "test_command" | "test_selection">, commands: readonly GateEntry[], git: TrustedGit, baseSha: string, log: (line: string) => void,
  mode: SelectionMode,
): Promise<{ commands: GateEntry[]; selection: TestSelection | null }> {
  const same = (c: GateEntry) => isTestCommand(repo.test_command, c);
  if (!repo.test_selection || !commands.some(same)) return { commands: commands.map(copyEntry), selection: null };
  let s: TestSelection;
  try {
    s = await selectTests(git, baseSha, repo.test_selection);
  } catch (err) {
    s = { full: true, reason: `full: the selection failed: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 300) };
  }
  log(`test selection (${mode}): ${s.reason}${s.full ? "" : `: ${s.files.join(" ")}`}`);
  for (const r of s.full ? [] : (s.reads ?? [])) log(`test selection (${mode}): ${r.test} reads ${r.path}`);
  return { commands: commands.map((c) => (same(c) && !s.full && mode === "enforce" ? withTestFiles(c, s.files) : copyEntry(c))), selection: s };
}

/** Whether `c` is `repo.test_command` itself, `extra` arguments after it allowed: a plain argv only (a folder entry is another command). */
function isTestCommand(test: readonly string[], c: GateEntry, extra = false): boolean {
  return gateDir(c) === undefined && (extra || gateArgv(c).length === test.length) && test.every((a, i) => gateArgv(c)[i] === a);
}

/**
 * One check before push's test selection (design §4, shadow mode), for the implement run's rounds and the interactive
 * finish: the project's stored mode, read once; each round's commands (selectedChecks); and, in shadow mode, the
 * failing test files of the whole test command that the round's narrowed selection left out (misses).
 */
export class PrePushSelection {
  private last: TestSelection | null = null;
  private ran = false;
  private readonly missed = new Set<string>();

  private constructor(
    readonly mode: SelectionMode, private readonly repo: Pick<FactoryConfig["repo"], "test_command" | "test_selection">, private readonly log: (line: string) => void,
  ) {}

  /** The stored mode is read only when `repo.test_selection` is set. */
  static async open(
    store: Pick<FactoryStore, "getLearnedSetting">, repo: Pick<FactoryConfig["repo"], "test_command" | "test_selection">, project: string, log: (line: string) => void,
  ): Promise<PrePushSelection> {
    return new PrePushSelection(repo.test_selection ? await selectionMode(store, project) : "shadow", repo, log);
  }

  async commands(commands: readonly GateEntry[], git: TrustedGit, baseSha: string): Promise<GateEntry[]> {
    const s = await selectedChecks(this.repo, commands, git, baseSha, this.log, this.mode);
    this.last = s.selection ?? this.last;
    return s.commands;
  }

  /** A round's result, noted: whether the test command ran, and in shadow mode its failing files outside the selection. */
  saw<R extends CheckRound>(round: R): R {
    const test = round.results.find((r) => isTestCommand(this.repo.test_command, ranEntry(r), true));
    if (!this.last || !test) return round;
    this.ran = true;
    if (this.mode === "shadow" && !test.ok && !this.last.full) for (const f of uncovered(this.last.files, failingTestFiles(test.tail))) this.missed.add(f);
    return round;
  }

  get misses(): string[] {
    return [...this.missed];
  }

  /** What the run records: the last selection, its mode and, after a miss, the missed files and the diff's files. Null: none made. */
  record(): SelectionRecord | null {
    const s = this.last;
    if (!s) return null;
    const miss = this.missed.size > 0 ? { misses: this.misses, changed: s.full ? [] : s.changed } : {};
    return { mode: this.mode, full: s.full, files: s.full ? [] : s.files, reason: s.reason, ...miss };
  }

  /**
   * Counts the run toward the mode switch (noteSelection): a miss, or a clean run; nothing in enforce mode or when the
   * test command never ran. A failed note is logged, never the run's failure.
   */
  async note(d: { store: Parameters<typeof noteSelection>[0]["store"]; clock: { now(): Date } }, project: string, run_id: RunId): Promise<void> {
    if (this.mode !== "shadow" || !this.ran) return;
    try {
      const to = await noteSelection(d, project, this.missed.size > 0 ? "miss" : "clean", run_id);
      if (this.missed.size > 0) this.log(`test selection miss: ${this.misses.join(" ")} (changed: ${this.record()?.changed?.join(" ") ?? ""})`);
      if (to) this.log(`test selection mode for ${project} is now ${to}`);
    } catch (err) {
      this.log(`test selection: the run could not be counted: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 300));
    }
  }
}

/** One done-when line's result in an implement run's check round (design 04-pre-push-gates, RFC 0024 WP3 phase 2). */
export interface DoneCheckResult {
  line: string;
  /** `not_run`: an earlier command of the round failed first. */
  result: "pass" | "fail" | "manual" | "not_run";
  /** The command as shown (commandText), or the manual reason. */
  check: string;
}

/** The argv of one done check: its repo check command, `repo.test_command` on its test file only, or null (manual). */
function doneCheckArgv(repo: FactoryConfig["repo"], c: DoneCheck): GateEntry | null {
  if ("manual" in c) return null;
  if ("test_file" in c) return withTestFiles(repo.test_command, [c.test_file]);
  return checkCommands(repo).find((cmd) => commandText(cmd) === c.command) ?? null;
}

/**
 * An implement run's check round with the item's done checks (design 04-pre-push-gates): the repo's check list, then
 * each test file check (`repo.test_command` on that file only) not already in it; a command check is the repo command
 * it names, run once. `manual` lines run nothing. `mark` puts each command's done-when lines on a round's results, by
 * place (a selection keeps the order). `testFile` names the test file of a round's failed test file check; `missing`
 * makes that failure say the file does not exist when `present` (the branch's files) lacks it. Null done_checks: the check list as before.
 */
export function doneCheckRound(repo: FactoryConfig["repo"], checks: readonly DoneCheck[] | null): {
  commands: GateEntry[]; mark<R extends CheckRound>(round: R): R; results(round: CheckRound): DoneCheckResult[] | undefined;
  testFile(round: CheckRound): string | null; missing<R extends CheckRound>(round: R, present: readonly string[]): R;
} {
  const commands = checkCommands(repo);
  const lines: string[][] = commands.map(() => []);
  const files: (string | undefined)[] = []; // each test file check's file, at its command's place
  // Each check's place in `commands`: -1 for a manual line (or a command no longer in the list), which runs nothing.
  const at = (checks ?? []).map((c) => {
    const argv = doneCheckArgv(repo, c);
    if (!argv) return -1;
    let i = commands.findIndex((cmd) => commandText(cmd) === commandText(argv));
    if (i < 0) {
      i = commands.push(argv) - 1;
      if ("test_file" in c) files[i] = c.test_file;
    }
    (lines[i] ??= []).push(c.line);
    return i;
  });
  const testFile = (round: CheckRound) => (round.failed ? (files[round.results.length - 1] ?? null) : null);
  return {
    commands,
    mark: (round) => {
      for (const [i, r] of round.results.entries()) if (lines[i]?.length) r.lines = [...lines[i]!];
      return round;
    },
    testFile,
    missing: (round, present) => {
      const file = testFile(round);
      if (round.failed && file && !present.includes(file)) {
        round.failed.how = missingTestFileText(file);
        round.failed.missing = { file, closest: closestTestFile(file, present) };
      }
      return round;
    },
    results: (round) => checks?.map((c, i): DoneCheckResult => {
      if ("manual" in c) return { line: c.line, result: "manual", check: c.reason };
      const r = at[i]! < 0 ? undefined : round.results[at[i]!];
      return { line: c.line, result: !r ? "not_run" : r.ok ? "pass" : "fail", check: "command" in c ? c.command : commandText(commands[at[i]!]!) };
    }),
  };
}

/** The words after a failed command that name the done-when lines it checks; empty when it checks none. */
export function checkedLinesText(r: Pick<CheckResult, "lines">): string {
  return r.lines?.length ? `; it checks the done-when line${r.lines.length === 1 ? "" : "s"} ${r.lines.map((l) => JSON.stringify(l)).join(", ")}` : "";
}

/**
 * The done-when lines' results an implement run's outcome carries (`done_checks`: on the succeeded data, or on a failed
 * outcome) as a state change's detail field, JSON text as `failed_checks` is; absent when the outcome has none.
 */
export function doneChecksDetail(fields: object | null | undefined): StateChangeDetail | undefined {
  const done = (fields as { done_checks?: unknown } | null | undefined)?.done_checks;
  return Array.isArray(done) ? { done_checks: JSON.stringify(done) } : undefined;
}

/** The PR body's line per manual done-when line: listed for a person, not run. */
export function manualLines(checks: readonly DoneCheck[] | null): string[] {
  return (checks ?? []).flatMap((c) => ("manual" in c ? [`Not run, a person checks it: "${c.line}" (${c.reason})`] : []));
}
