import { isObj } from "./outputs.js";
import { isCovered } from "./policy.js";

// Tests that pin a change (design 04-triage, 2026-11-25): the base test files holding a string the spec quotes.

/** A double-quoted string of at least this many characters names text a base test may assert. */
export const MIN_PIN_CHARS = 4;

// Every quoted string, short ones too, so a short one's closing quote never opens the next; the length is checked after.
const QUOTED = /"([^"\n]*)"/g;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The distinct double-quoted strings of four or more characters in `text`, in order: the pin rule. */
export function pinStrings(text: string): string[] {
  return [...new Set([...text.matchAll(QUOTED)].map((m) => m[1]!).filter((s) => s.trim().length >= MIN_PIN_CHARS))];
}

/**
 * The pin strings of `text` (a test file) that a removed line of `diff` (`git diff -U0` output: a line starting with
 * `-`, not `---`) contains, in order. Empty: the file quotes no text the diff removed (design 04-pre-push-gates).
 */
export function removedPins(text: string, diff: string): string[] {
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  return removed.length === 0 ? [] : pinStrings(text).filter((s) => removed.some((l) => l.includes(s)));
}

/** The distinct double-quoted strings of four or more characters in an answer's problem, done criteria and desired output, in order. */
export function quotedStrings(answer: unknown): string[] {
  if (!isObj(answer)) return [];
  const texts = [answer.problem, ...strs(answer.done_criteria), answer.desired_output].filter((t): t is string => typeof t === "string");
  return [...new Set(texts.flatMap(pinStrings))];
}

/**
 * The answer with each pinned test file joined to `allowed_paths` (unless one covers it already) and `files_to_change`, and
 * listed as `pinned_tests`. An answer that is not an object, or no file, leaves the answer as it is.
 */
export function addPinnedTests(answer: unknown, files: readonly string[]): unknown {
  if (!isObj(answer) || files.length === 0) return answer;
  const pinned = [...new Set(files)];
  const allowed = strs(answer.allowed_paths), change = strs(answer.files_to_change);
  return {
    ...answer,
    allowed_paths: [...allowed, ...pinned.filter((f) => !isCovered(f, allowed))],
    files_to_change: [...change, ...pinned.filter((f) => !change.includes(f))],
    pinned_tests: pinned,
  };
}

/**
 * The answer with the base test files that hold one of its quoted strings (`quotedStrings`). `search` returns the files under
 * tests/ that contain a string (a git grep of the base checkout); it is not called when the answer quotes nothing.
 */
export async function pinTests(answer: unknown, search: (text: string) => Promise<readonly string[]>): Promise<unknown> {
  const files: string[] = [];
  for (const text of quotedStrings(answer)) files.push(...(await search(text)));
  return addPinnedTests(answer, files);
}
