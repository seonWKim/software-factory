/**
 * Mechanical merges (design §5, issue #297): the base-merge conflicts and migration-number collisions the worker
 * settles in code, with no model call. Pure functions plus two drivers that act only through a small git and
 * file interface, so the worker passes its sandbox calls and the tests pass fakes.
 *
 * - Appended lines: a conflicted file where both sides only added lines to the common ancestor (History lines,
 *   index lines, new step lines) is merged as the base branch's added lines, then the work branch's, at each
 *   place. Any removed or changed line on either side, or a file one side deleted or both added, is not
 *   mechanical: the existing conflict path (an agent step, the resolve run) takes it.
 * - Migration numbers: a MySQL step file the branch adds (`migrations/mysql/NNNN-<name>.sql|ts`) whose number
 *   the base already has is moved, with the branch's other new steps, to the next free numbers, and literal
 *   references to the old file name in the files the branch changed follow. Skipped when the branch also changes
 *   a SQLite schema file, whose numbering lives in code and is a real conflict.
 */

/** Where MySQL step files live (design §5 MySQL schema steps). */
export const MYSQL_STEPS_DIR = "migrations/mysql/";
const STEP_FILE = /^migrations\/mysql\/(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(sql|ts)$/;
/** A SQLite schema file: SQLite numbers its migrations in code, so a collision there needs a real resolution. */
const SQLITE_SCHEMA = /^src\/impl\/store\/sqlite\/.*(schema|migration)[^/]*$/;

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
 * What the drivers below need from a run folder. The worker writes through git (a blob, the index entry, then
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
  /** `git mv -- from to`. */
  move(from: string, to: string): Promise<void>;
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

/** A step file's number and name, or null for anything else (the README, a file outside the folder). */
export function stepFile(path: string): { number: number; rest: string } | null {
  const m = STEP_FILE.exec(path);
  return m ? { number: Number(m[1]), rest: `${m[2]}.${m[3]}` } : null;
}

const pad = (n: number) => String(n).padStart(4, "0");

/** One step file moved to a new number. */
export interface Renumbering {
  from: string;
  to: string;
}

/**
 * The moves that give the branch's new step files free numbers: none when no new step's number is taken in the
 * base. Otherwise every new step, in number order, gets the next number after the base's highest, so the
 * branch's steps keep their order and the folder stays contiguous.
 */
export function renumberPlan(baseFiles: readonly string[], added: readonly string[]): Renumbering[] {
  const taken = new Set<number>();
  let highest = 0;
  for (const f of baseFiles) {
    const s = stepFile(f);
    if (!s) continue;
    taken.add(s.number);
    highest = Math.max(highest, s.number);
  }
  const mine = added
    .map((f) => ({ f, s: stepFile(f) }))
    .filter((x): x is { f: string; s: { number: number; rest: string } } => x.s !== null && !baseFiles.includes(x.f))
    .sort((x, y) => x.s.number - y.s.number || x.f.localeCompare(y.f));
  if (!mine.some((x) => taken.has(x.s.number))) return [];
  return mine
    .map((x, i) => ({ from: x.f, to: `${MYSQL_STEPS_DIR}${pad(highest + i + 1)}-${x.s.rest}` }))
    .filter((r) => r.from !== r.to);
}

/** Whether a path list changes a SQLite schema file (renumbering is then skipped). */
export function touchesSqliteSchema(paths: readonly string[]): boolean {
  return paths.some((p) => SQLITE_SCHEMA.test(p));
}

const stem = (path: string) => path.slice(MYSQL_STEPS_DIR.length).replace(/\.(sql|ts)$/, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with each literal reference to an old step name (`0025-name`, with or without its folder) renamed. */
export function renameStepRefs(text: string, plan: readonly Renumbering[]): string {
  let out = text;
  for (const r of plan) out = out.replace(new RegExp(`(?<![0-9A-Za-z])${escape(stem(r.from))}(?![0-9A-Za-z-])`, "g"), stem(r.to));
  return out;
}

/**
 * Applies a renumbering plan in the run folder: moves each step file, then renames literal references to the
 * old names in `changed` (the files the branch changes against the base, the moved steps included), staged.
 * Returns the files written besides the moves. Tests and other files keep anything beyond a literal name.
 */
export async function applyRenumbering(io: MergeIO, plan: readonly Renumbering[], changed: readonly string[]): Promise<string[]> {
  for (const r of plan) await io.move(r.from, r.to);
  const moved = new Map(plan.map((r) => [r.from, r.to]));
  const edited: string[] = [];
  for (const old of new Set(changed)) {
    const path = moved.get(old) ?? old;
    const text = await io.stage(path, 0);
    if (text === null) continue;
    const next = renameStepRefs(text, plan);
    if (next === text) continue;
    await io.write(path, next);
    edited.push(path);
  }
  return edited;
}
