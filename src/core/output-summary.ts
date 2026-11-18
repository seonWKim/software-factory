// Pure helpers that turn a command's or agent's raw output into what a person reads first (issue #229): no
// terminal colour codes, the first error line, and the failing test names (with their first error line, for a CI log).

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links) a terminal would interpret.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `text` without terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const ERROR_LINE = /\b(?:[A-Z][A-Za-z]*Error|error TS\d+|Error:|ERR!|FAIL|failed|fatal:|MODULE_NOT_FOUND)\b/;

/** The first line that names an error, trimmed and at most 300 characters; null when none does. */
export function firstErrorLine(text: string): string | null {
  for (const line of stripAnsi(text).split("\n")) {
    const t = line.trim();
    if (t && ERROR_LINE.test(t)) return t.length > 300 ? `${t.slice(0, 299)}…` : t;
  }
  return null;
}

/** A CI log line's leading timestamp (GitHub Actions writes one before every line). */
const LOG_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
/** A line naming an error: `AssertionError: ...`, `TypeError: ...`, `Error: ...`. */
const ASSERTION_LINE = /\b(?:[A-Z][A-Za-z]*)?Error\b/;
/** Characters kept of a failing test's message. */
const MESSAGE_CHARS = 300;

/** The test a vitest `FAIL  <file> > <name>` line names (its duration dropped), or null for any other line. */
function failName(line: string): string | null {
  const m = /^\s*FAIL\s+(\S+\.test\.tsx?(?:\s+>\s+.+)?)\s*$/.exec(line);
  return m ? m[1]!.replace(/\s+\d+ms$/, "").trim() : null;
}

/** The tests a vitest run reports as failed (`FAIL  <file> > <name>`), in order, each once, at most `max`. */
export function failingTests(text: string, max = 5): string[] {
  const names: string[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const name = failName(line);
    if (name === null) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length === max) break;
  }
  return names;
}

/** A failing test and the first error line under its `FAIL` line (null when it has none). */
export interface FailingTest {
  test: string;
  message: string | null;
}

/**
 * The tests a vitest run in a CI job's log reports as failed (design 05-ci-gate): each `FAIL` line's test once, in
 * order, at most `max`, with the first line naming an error under its first `FAIL` line (trimmed, at most 300
 * characters), up to the next `FAIL` line or vitest's `⎯` separator. Log timestamps and terminal codes are dropped.
 */
export function failingTestDetails(text: string, max: number): FailingTest[] {
  const out: FailingTest[] = [];
  let open: FailingTest | null = null;
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.replace(LOG_TIME, "");
    const name = failName(line);
    if (name !== null) {
      if (out.some((t) => t.test === name)) {
        open = null;
        continue;
      }
      if (out.length === max) break;
      open = { test: name, message: null };
      out.push(open);
      continue;
    }
    if (!open) continue;
    const t = line.trim();
    if (t.startsWith("⎯")) open = null;
    else if (ASSERTION_LINE.test(t)) {
      open.message = t.length > MESSAGE_CHARS ? `${t.slice(0, MESSAGE_CHARS - 1)}…` : t;
      open = null;
    }
  }
  return out;
}
