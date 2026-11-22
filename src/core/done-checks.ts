// Done-when checks (design 04-triage.md, 2026-11-22; RFC 0024 WP3 phase 1): triage gives each done-when line, in
// order, one check: a repo check command (`repo.check_commands`, else `test_command`, as the command text), a test
// file under `tests/`, or `manual: true` with a reason. The spec carries them and the item stores them; running them
// in the sandbox is a later phase.

import { checkCommands, commandText } from "./checks.js";
import type { FactoryConfig } from "./config.js";

/** One done-when line's check: a repo check command (its text), a test file, or a manual reason. */
export type DoneCheck = { line: string; command: string } | { line: string; test_file: string } | { line: string; manual: true; reason: string };

/**
 * The JSON Schema of triage's `done_checks`. The three forms share one item schema (the runners' schema check has no
 * anyOf); parseDoneChecks takes exactly one of them per entry.
 */
export const DONE_CHECKS_SCHEMA = {
  type: "array",
  description: "One entry per done_criteria line, in the same order: {line, command}, {line, test_file} or {line, manual: true, reason}.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["line"],
    properties: {
      line: { type: "string", description: "The done-when line, exactly as written in done_criteria." },
      command: { type: "string", description: "One of the repo's check commands, as its text, when it checks the line." },
      test_file: { type: "string", description: "A test file under tests/ that checks the line." },
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

const FORMS = "must be {line, command}, {line, test_file} or {line, manual: true, reason}";
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
  if (keys === "test_file") return typeof o.test_file === "string" && isTestFile(o.test_file) ? { line, test_file: o.test_file } : `${at}.test_file: must be a repo-relative path under tests/`;
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

/** A check as the spec comment shows it after its done-when line: `check: <command or test file>`, or `manual: <reason>`. */
export function doneCheckText(c: DoneCheck): string {
  if ("command" in c) return `check: \`${c.command}\``;
  if ("test_file" in c) return `check: \`${c.test_file}\``;
  return `manual: ${c.reason}`;
}
