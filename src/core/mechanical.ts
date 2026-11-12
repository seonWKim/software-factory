/**
 * Mechanical merges (design §5, issue #297): the base-merge conflicts the worker settles in code, with no model
 * call. Pure functions plus a driver that acts only through a small git and file interface, so the worker passes
 * its sandbox calls and the tests pass fakes.
 *
 * Appended lines: a conflicted file where both sides only added lines to the common ancestor (History lines,
 * index lines, new step lines) is merged as the base branch's added lines, then the work branch's, at each place.
 * Any removed or changed line on either side, or a file one side deleted or both added, is not mechanical: the
 * existing conflict path (an agent step, the resolve run) takes it.
 */

interface Lines {
  lines: string[];
  /** Whether the text ends with a newline. */
  eol: boolean;
}

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], eol: false };
  const eol = text.endsWith("\n");
  return { lines: (eol ? text.slice(0, -1) : text).split("\n"), eol };
}

/**
 * The lines `side` adds to `ancestor`, by gap: `gaps[k]` comes before ancestor line k (`gaps[n]` after the last).
 * Null when `side` removes or changes any ancestor line (the ancestor is not a subsequence of it).
 */
function insertions(ancestor: readonly string[], side: readonly string[]): string[][] | null {
  const gaps: string[][] = Array.from({ length: ancestor.length + 1 }, () => []);
  let i = 0;
  for (const line of side) {
    if (i < ancestor.length && line === ancestor[i]) i++;
    else gaps[i]!.push(line);
  }
  return i === ancestor.length ? gaps : null;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The merge of a conflicted file whose two sides only added lines to their common ancestor: at each place, the
 * base branch's added lines, then the work branch's (one copy when both added the same lines). Null when it is
 * not that: a side removed or changed a line, one side changed nothing (not a real conflict), or the sides
 * disagree with the ancestor on the final newline.
 */
export function appendMerge(ancestor: string, base: string, branch: string): string | null {
  const a = splitLines(ancestor);
  const b = splitLines(base);
  const w = splitLines(branch);
  if (a.lines.length > 0 && (b.eol !== a.eol || w.eol !== a.eol)) return null;
  if (b.eol !== w.eol) return null;
  const fromBase = insertions(a.lines, b.lines);
  const fromBranch = insertions(a.lines, w.lines);
  if (!fromBase || !fromBranch) return null;
  if (fromBase.every((g) => g.length === 0) || fromBranch.every((g) => g.length === 0)) return null;
  const out: string[] = [];
  for (let k = 0; k <= a.lines.length; k++) {
    out.push(...fromBase[k]!);
    if (!same(fromBase[k]!, fromBranch[k]!)) out.push(...fromBranch[k]!);
    if (k < a.lines.length) out.push(a.lines[k]!);
  }
  return out.join("\n") + (b.eol ? "\n" : "");
}

/**
 * What the driver below needs from a run folder. The worker writes through git (a blob, the index entry, then
 * the checkout of that entry), never through the working tree, so a symlink in the tree cannot redirect a write.
 */
export interface MergeIO {
  /**
   * The text of `path` at index stage 0 (merged), 1 (common ancestor), 2 (the work branch, HEAD) or 3 (the
   * merged-in base); null when the stage is missing (the file was added or deleted on a side) or is not a
   * regular file (a symlink, a submodule).
   */
  stage(path: string, n: 0 | 1 | 2 | 3): Promise<string | null>;
  /** Stages `text` as `path` (replacing any conflict stages) and checks it out. */
  write(path: string, text: string): Promise<void>;
}

/**
 * Merges every conflicted file in code when each one only has appended lines on both sides, and stages them.
 * All or nothing: when any file is not mechanical, nothing is written and the result is false, so the caller's
 * conflict path sees the merge exactly as git left it.
 */
export async function mergeAppendedConflicts(io: MergeIO, conflicts: readonly string[]): Promise<boolean> {
  if (conflicts.length === 0) return false;
  const merged: [string, string][] = [];
  for (const path of conflicts) {
    const [ancestor, branch, base] = [await io.stage(path, 1), await io.stage(path, 2), await io.stage(path, 3)];
    if (ancestor === null || branch === null || base === null) return false;
    const text = appendMerge(ancestor, base, branch);
    if (text === null) return false;
    merged.push([path, text]);
  }
  for (const [path, text] of merged) await io.write(path, text);
  return true;
}
