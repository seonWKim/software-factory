// Pure helpers that turn a command's or agent's raw output into what a person reads first (issue #229): no
// terminal colour codes, the first error line, and the failing test names.

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

/** The tests a vitest run reports as failed (`FAIL  <file> > <name>`), in order, each once, at most `max`. */
export function failingTests(text: string, max = 5): string[] {
  const names: string[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const m = /^\s*FAIL\s+(\S+\.test\.tsx?(?:\s+>\s+.+)?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!.replace(/\s+\d+ms$/, "").trim();
    if (!names.includes(name)) names.push(name);
    if (names.length === max) break;
  }
  return names;
}
