// Done-when checks (design 04-triage.md, 2026-11-22; RFC 0024 WP3 phase 1): triage gives each done-when line, in
// order, one check: a repo check command (`repo.check_commands`, else `test_command`, as the command text), a test
// file under `tests/`, or `manual: true` with a reason. The spec carries them and the item stores them; running them
// in the sandbox is a later phase.

import { checkCommands, commandText } from "./checks.js";
import type { FactoryConfig } from "./config.js";
import { isCovered } from "./policy.js";

/**
 * One done-when line's check: a repo check command (its text), a test file (`new: true` when the base lacks it and the
 * run creates it, design 04-triage), or a manual reason.
 */
export type DoneCheck = { line: string; command: string } | { line: string; test_file: string; new?: true } | { line: string; manual: true; reason: string };

/**
 * The JSON Schema of triage's `done_checks`. The three forms share one item schema (the runners' schema check has no
 * anyOf); parseDoneChecks takes exactly one of them per entry.
 */
export const DONE_CHECKS_SCHEMA = {
  type: "array",
  description: "One entry per done_criteria line, in the same order: {line, command}, {line, test_file} (with new: true for a file the change creates) or {line, manual: true, reason}.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["line"],
    properties: {
      line: { type: "string", description: "The done-when line, exactly as written in done_criteria." },
      command: { type: "string", description: "One of the repo's check commands, as its text, when it checks the line." },
      test_file: { type: "string", description: "A test file under tests/ that checks the line." },
      new: { const: true, description: "With test_file: the file does not exist on the base and the change creates it; list it in allowed_paths." },
      manual: { const: true, description: "Only when no command or test file can check the line: a person checks it." },
      reason: { type: "string", description: "With manual: why a person checks the line." },
    },
  },
};

/** The command texts a `command` check may name (owner answer, WP3): the repo's check commands, else its test command. */
export const doneCheckCommands = (repo: FactoryConfig["repo"]): string[] => checkCommands(repo).map(commandText);

/** A safe repo-relative path under `tests/`: no absolute path, no empty, `.` or `..` segment. */
const isTestFile = (p: string): boolean => {
  const parts = p.split("/");
  return parts.length > 1 && parts[0] === "tests" && parts.every((s) => s !== "" && s !== "." && s !== "..");
};

const FORMS = "must be {line, command}, {line, test_file}, {line, test_file, new: true} or {line, manual: true, reason}";
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** One entry, or the error naming it (`done_checks[i]`). */
function parseEntry(e: unknown, line: string | undefined, at: string, commands: readonly string[] | undefined): DoneCheck | string {
  if (line === undefined) return `${at}: no done-when line has this place; give one entry per done_criteria line`;
  if (typeof e !== "object" || e === null || Array.isArray(e)) return `${at}: ${FORMS}`;
  const o = e as Record<string, unknown>;
  if (o.line !== line) return `${at}.line: must be done-when line ${JSON.stringify(line)} as written, in the same order`;
  const keys = Object.keys(o).filter((k) => k !== "line").sort().join(",");
  if (keys === "" || (o.manual === true && !filled(o.reason))) return `${at}: the done-when line has neither a check nor a manual reason`;
  if (keys === "command" && filled(o.command)) {
    if (commands && !commands.includes(o.command.trim())) return `${at}.command: must be one of the repo's check commands: ${commands.join("; ")}`;
    return { line, command: o.command.trim() };
  }
  if (keys === "test_file" || (keys === "new,test_file" && o.new === true)) {
    if (typeof o.test_file !== "string" || !isTestFile(o.test_file)) return `${at}.test_file: must be a repo-relative path under tests/`;
    return { line, test_file: o.test_file, ...(o.new === true ? { new: true as const } : {}) };
  }
  if (keys === "manual,reason" && o.manual === true) return { line, manual: true, reason: (o.reason as string).trim() };
  return `${at}: ${FORMS}`;
}

/**
 * Triage's `done_checks` against its `done_criteria`: one entry per line, in order. `commands` (the repo's check
 * commands, from the controller's triage branch) also requires the list and each `command` to be one of them;
 * without it (a stored answer read again, a session's spec file) a missing list is none: items triaged before keep null.
 */
export function parseDoneChecks(v: unknown, lines: readonly string[], commands?: readonly string[]): { ok: true; value: DoneCheck[] | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) {
    return commands ? { ok: false, error: "done_checks: required, one check or manual reason per done-when line" } : { ok: true, value: undefined };
  }
  if (!Array.isArray(v)) return { ok: false, error: "done_checks: must be a list, one entry per done_criteria line" };
  const out: DoneCheck[] = [];
  for (let i = 0; i < Math.max(v.length, lines.length); i++) {
    const at = `done_checks[${i}]`;
    const entry = i < v.length ? parseEntry(v[i], lines[i], at, commands) : `${at}: the done-when line has neither a check nor a manual reason`;
    if (typeof entry === "string") return { ok: false, error: entry };
    out.push(entry);
  }
  return { ok: true, value: out };
}

/** A file's name split at its first dot: the words before it (under tests/, lower case), and the suffix (`.test.ts`). */
function nameParts(path: string): { words: string[]; suffix: string } {
  const rest = path.replace(/^tests\//, "");
  const slash = rest.lastIndexOf("/");
  const dot = rest.indexOf(".", slash + 1);
  const stem = dot < 0 ? rest : rest.slice(0, dot);
  return { words: stem.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), suffix: dot < 0 ? "" : rest.slice(dot) };
}

/**
 * The existing test file closest by name to `missing` (design 04-pre-push-gates): of the files in `files` with the same
 * suffix, the one sharing the most words with it, ties in sorted order; null when none shares a word.
 */
export function closestTestFile(missing: string, files: readonly string[]): string | null {
  const want = nameParts(missing);
  let best: { file: string; score: number } | null = null;
  for (const file of [...files].sort()) {
    const got = nameParts(file);
    if (file === missing || got.suffix !== want.suffix) continue;
    const score = new Set(got.words.filter((w) => want.words.includes(w))).size;
    if (score > 0 && (!best || score > best.score)) best = { file, score };
  }
  return best?.file ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** An exact file under tests/ (no folder, no glob): a name triage checks against the repo's files. */
const isExactTestPath = (p: string): boolean => p.startsWith("tests/") && !/[*?[]/.test(p) && /\/[^/]*\.[^/]+$/.test(p);

/** The decision that names one swap of an unknown test file for the closest existing one. */
const swapDecision = (file: string, closest: string) => ({
  question: `The spec named \`${file}\`, which does not exist; it now names \`${closest}\`, the closest existing test file by name. Keep the swap?`,
  reason: "A check on a test file that does not exist fails as if the code were broken.", options: [], default: "keep the swap", owner_only: false,
});

/**
 * Triage's test file names against the repo's files (design 04-pre-push-gates), before parseTriage: each exact tests/
 * file in allowed_paths or files_to_change that `files` (the repo's tests/ files) lacks is replaced everywhere it is
 * named, done-when lines included, by the closest existing test file by name, and a decision names each swap. A name no
 * file is close to stays: a file the run creates. A done_checks test file is never swapped (design 04-triage): a missing
 * one is new or is sent back: `refusal` names it (checkFileRefusal). Anything else is left for parseTriage.
 */
export function checkTestFiles(v: unknown, files: readonly string[]): { answer: unknown; refusal: string | null } {
  return { answer: swapTestFiles(v, files), refusal: checkFileRefusal(v, files) };
}

function swapTestFiles(v: unknown, files: readonly string[]): unknown {
  if (!isObj(v) || !(v.decisions === undefined || Array.isArray(v.decisions))) return v;
  const lists = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const checked = new Set(lists(v.done_checks).flatMap((c) => (isObj(c) && isStr(c.test_file) ? [c.test_file] : [])));
  const named = [v.allowed_paths, v.files_to_change].flatMap((l) => (isStrs(l) ? l.filter((p) => isExactTestPath(p) && !checked.has(p)) : []));
  const swap = new Map([...new Set(named)].flatMap((f) => { const c = files.includes(f) ? null : closestTestFile(f, files); return c ? [[f, c] as const] : []; }));
  if (swap.size === 0) return v;
  const path = (p: unknown) => (isStr(p) ? (swap.get(p) ?? p) : p);
  const text = (t: unknown) => (isStr(t) ? [...swap].reduce((s, [from, to]) => s.split(from).join(to), t) : t);
  const paths = (l: unknown) => (isStrs(l) ? [...new Set(l.map((p) => path(p) as string))] : l);
  return {
    ...v,
    ...(Array.isArray(v.done_criteria) ? { done_criteria: v.done_criteria.map(text) } : {}),
    ...(Array.isArray(v.done_checks) ? { done_checks: v.done_checks.map((c) => (isObj(c) ? { ...c, line: text(c.line) } : c)) } : {}),
    allowed_paths: paths(v.allowed_paths), files_to_change: paths(v.files_to_change),
    decisions: [...lists(v.decisions), ...[...swap].map(([from, to]) => swapDecision(from, to))],
  };
}

/**
 * A triage answer's done-check test files that cannot run as written (design 04-triage): each one `files` (the base's
 * tests/ files) lacks and that is not marked `new: true`, and each marked one allowed_paths does not cover. The error
 * that names them, for the one re-ask and the run's failure; null when there is none (or no list to read).
 */
export function checkFileRefusal(v: unknown, files: readonly string[]): string | null {
  if (!isObj(v) || !Array.isArray(v.done_checks)) return null;
  const allowed = isStrs(v.allowed_paths) ? v.allowed_paths : [];
  const tests = v.done_checks.flatMap((c) => (isObj(c) && isStr(c.test_file) ? [{ file: c.test_file, marked: c.new === true }] : []));
  const missing = [...new Set(tests.filter((c) => !c.marked && !files.includes(c.file)).map((c) => c.file))];
  const uncovered = [...new Set(tests.filter((c) => c.marked && !isCovered(c.file, allowed)).map((c) => c.file))];
  const parts = [
    ...(missing.length > 0 ? [`these test files do not exist on the base and are not marked new: true: ${missing.join(", ")}`] : []),
    ...(uncovered.length > 0 ? [`these test files are marked new: true but allowed_paths does not cover them: ${uncovered.join(", ")}`] : []),
  ];
  return parts.length > 0 ? `done_checks: ${parts.join("; ")}` : null;
}

/** A check as the spec comment shows it after its done-when line: `check: <command or test file>`, or `manual: <reason>`. */
export function doneCheckText(c: DoneCheck): string {
  if ("command" in c) return `check: \`${c.command}\``;
  if ("test_file" in c) return `check: \`${c.test_file}\`${c.new ? ", new file" : ""}`;
  return `manual: ${c.reason}`;
}
