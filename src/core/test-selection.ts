import type { FactoryConfig } from "./config.js";
import type { TrustedGit } from "./pre-push.js";
import type { Run, RunId, Timestamp, WorkItem } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

// Test selection before push (design §4, decided 2026-11-21): the check before push (the implement run's two
// rounds and the interactive finish) runs the test command on the test files that can reach the branch's changed
// files, plus a fixed always-run list. A test that reads a file or folder by a literal path reaches what it reads
// (the read rule, decided 2026-11-23). The merge check runs the full list, so a test this graph cannot see (one that
// reads a path built at run time, or imports a string built at run time) still runs before a merge.
// Shadow mode (design §4, RFC 0023 §4): the selection narrows the test command only in enforce mode, a per-project
// learned setting. In shadow mode (no stored mode) the full command runs and a failing test file outside the
// selection is a miss; ENFORCE_AFTER clean runs in a row switch to enforce, a miss at the merge check back to shadow.

/** `repo.test_selection`: hand-written hub files (neither picked nor walked) and the always-run files or prefixes. */
export type TestSelectionConfig = NonNullable<FactoryConfig["repo"]["test_selection"]>;

/** Full: the whole test command, and why. Otherwise the test files (and always-run prefixes) to run, why, and the diff's files. */
export type TestSelection =
  | { full: true; reason: string }
  | { full: false; files: string[]; reason: string; changed: string[]; reads?: ReadPick[] };

/** A test picked because it reads a changed file: the path it reads, a folder ending in `/`. */
export interface ReadPick {
  test: string;
  path: string;
}

/** The folders the import graph reads. A changed file under none of them is no source or test file (docs, config). */
const GRAPH_ROOTS = ["src/", "web/src/", "tests/"] as const;
const PACKAGE_FILES = ["package.json", "package-lock.json"];
/** Vitest's setup files run before every test. A helper under tests/helpers/ is walked like a source file: its importers are selected. */
const TEST_SETUP = ["tests/setup/"];
const isTestConfig = (p: string) => p === "vitest.config.ts" || /(^|\/)tsconfig[^/]*\.json$/.test(p);
/** A vitest test file, as vitest.config.ts includes them. */
const isTest = (p: string) => p.startsWith("tests/") && /\.test\.tsx?$/.test(p);
const inGraph = (p: string) => GRAPH_ROOTS.some((r) => p.startsWith(r));

/**
 * The relative import specifiers git grep matches: `from "./x"`, `import "./x"`, `import("./x")`, `require("./x")`,
 * `vi.mock("./x")` and `vi.importActual<...>("./x")`. POSIX ERE, so no `\s`; SPECIFIERS is the same in JS.
 */
const GREP_PATTERN = `(from|import|require|vi\\.mock|vi\\.importActual)(<[^>]*>)?[[:space:]]*\\(?[[:space:]]*["']\\.\\.?/[^"']*["']`;
const SPECIFIERS = /(?:from|import|require|vi\.mock|vi\.importActual)(?:<[^>]*>)?\s*\(?\s*["'](\.\.?\/[^"']*)["']/g;
/** A type-only statement (`import type`, `export type`): no runtime edge. The full typecheck covers it (RFC 0023 §3). */
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b/;

/** The full-list rule a changed file hits, as the reason; null when it hits none. */
function fullReason(path: string, hubs: readonly string[]): string | null {
  if (hubs.includes(path)) return `full: hub file ${path} changed`;
  if (PACKAGE_FILES.includes(path)) return `full: package file ${path} changed`;
  if (TEST_SETUP.some((h) => path.startsWith(h))) return `full: test setup ${path} changed`;
  if (isTestConfig(path)) return `full: test config ${path} changed`;
  return null;
}

const folderOf = (file: string) => file.split("/").slice(0, -1).join("/");

/** Repo-relative paths joined, `.` and `..` segments folded (core/ imports no node: module); null when it leaves the repository. */
function fold(paths: readonly string[]): string | null {
  const parts: string[] = [];
  for (const seg of paths.join("/").split("/")) {
    if (seg === "..") {
      if (parts.pop() === undefined) return null;
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** The tracked file `spec` names from `from`, trying the TypeScript sources a `.js` specifier stands for; null when none. */
function resolveSpecifier(from: string, spec: string, known: ReadonlySet<string>): string | null {
  const target = fold([folderOf(from), spec]);
  if (target === null) return null;
  const stem = target.replace(/\.(m|c)?jsx?$/, "");
  const tries = [target, `${stem}.ts`, `${stem}.tsx`, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}/index.ts`, `${target}/index.tsx`];
  return tries.find((t) => known.has(t)) ?? null;
}

/**
 * Importer lists by imported file, from `git grep -z` output (`path\0line` per line): runtime imports only, so a
 * type-only line adds no edge (the closing line of a multi-line `import type` still does: wider, never narrower).
 * Unresolved specifiers are dropped.
 */
export function importersOf(grep: string, known: ReadonlySet<string>): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const row of grep.split("\n")) {
    const [from, line] = row.split("\0");
    if (!from || line === undefined || TYPE_ONLY.test(line)) continue;
    for (const m of line.matchAll(SPECIFIERS)) {
      const to = resolveSpecifier(from, m[1]!, known);
      if (to === null || to === from) continue;
      const set = by.get(to) ?? new Set<string>();
      set.add(from);
      by.set(to, set);
    }
  }
  return by;
}

/** The read calls whose first argument names a path a test reads (the read rule). POSIX ERE for git grep; READ_CALL is the same in JS. */
const READ_PATTERN = "(readFileSync|readFile|readdirSync|readdir|existsSync|glob)[[:space:]]*\\(";
const READ_CALL = /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|glob)\s*\(/g;
/** The lines the read scan keeps: the read calls and the const bindings a path may name. */
const READ_LINES = `${READ_PATTERN}|const[[:space:]]`;
const BINDING = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?!=)/g;
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** The expression starting at `at` up to the first `,`, `;` or unmatched closing bracket outside strings and brackets, and where it ends. */
function expressionAt(text: string, at: number): { expr: string; end: number } {
  const open: string[] = [];
  let i = at;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
    } else if (CLOSE[c]) open.push(CLOSE[c]);
    else if (open.length > 0 && c === open.at(-1)) open.pop();
    else if (open.length === 0 && (c === "," || c === ";" || c === ")" || c === "]" || c === "}")) break;
  }
  return { expr: text.slice(at, i).trim(), end: i };
}

/** The arguments of a call whose `(` is at `at`, when its `)` closes the text; null otherwise. */
function callArgs(text: string, at: number): string[] | null {
  const args: string[] = [];
  let i = at + 1;
  for (;;) {
    const { expr, end } = expressionAt(text, i);
    if (expr !== "") args.push(expr);
    if (text[end] !== ",") return text[end] === ")" && text.slice(end + 1).trim() === "" ? args : null;
    i = end + 1;
  }
}

/**
 * The repo-relative paths an expression in `file` names: a string literal (from the repository root, where the tests
 * run), `import.meta.dirname` (the file's folder), `join(...)`/`resolve(...)` of these, `new URL("<literal>",
 * import.meta.url)`, `fileURLToPath(import.meta.url)` (the file) or `dirname(...)` of one, or a const of `file` bound to one (every binding of the name: wider,
 * never narrower). Empty for anything else, a variable or an expression not built from literals.
 */
function pathsOf(expr: string, file: string, bindings: ReadonlyMap<string, string[]>, depth = 0): string[] {
  if (depth > 8) return [];
  const lit = /^(["'`])([^"'`\\$]*)\1$/.exec(expr);
  if (lit) return lit[2]!.startsWith("/") ? [] : [lit[2]!];
  if (expr === "import.meta.dirname") return [folderOf(file)];
  if (expr === "import.meta.url") return [file];
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return (bindings.get(expr) ?? []).flatMap((e) => pathsOf(e, file, bindings, depth + 1));
  const call = /^(?:(?:path|posix)\.)?(join|resolve|dirname|fileURLToPath|new URL)\s*\(/.exec(expr);
  const args = call ? callArgs(expr, call[0].length - 1) : null;
  if (!call || !args || args.length === 0) return [];
  if (call[1] === "fileURLToPath") return args.length === 1 ? pathsOf(args[0]!, file, bindings, depth + 1) : [];
  if (call[1] === "dirname") return args.length === 1 ? pathsOf(args[0]!, file, bindings, depth + 1).map((p) => `${p}/..`) : [];
  if (call[1] === "new URL") {
    const rel = /^(["'`])([^"'`\\$]*)\1$/.exec(args[0]!);
    return rel && args[1] === "import.meta.url" && !rel[2]!.startsWith("/") ? [`${folderOf(file)}/${rel[2]}`] : [];
  }
  let joined = [""];
  for (const a of args) {
    const each = pathsOf(a, file, bindings, depth + 1);
    joined = joined.flatMap((j) => each.map((p) => (j === "" ? p : `${j}/${p}`))).slice(0, 64);
  }
  return joined;
}

/**
 * Reader lists by read file, each with the path its reader names (a folder ending in `/`), from `git grep -z` output
 * of the files under tests/ that make a read call. A path that names a tracked file links that file; one that names
 * a folder links every tracked file under it. A glob reads from the folder before its first pattern segment. The
 * repository root and a path outside it link nothing.
 */
export function readersOf(grep: string, known: ReadonlySet<string>): Map<string, Map<string, string>> {
  const lines = new Map<string, string[]>();
  for (const row of grep.split("\n")) {
    const [from, line] = row.split("\0");
    if (from && line !== undefined) lines.set(from, [...(lines.get(from) ?? []), line]);
  }
  const by = new Map<string, Map<string, string>>();
  const link = (from: string, file: string, via: string) => {
    if (file === from) return;
    const set = by.get(file) ?? new Map<string, string>();
    if (!set.has(from)) set.set(from, via);
    by.set(file, set);
  };
  for (const [from, text] of lines) {
    const bindings = new Map<string, string[]>();
    for (const line of text) {
      for (const m of line.matchAll(BINDING)) bindings.set(m[1]!, [...(bindings.get(m[1]!) ?? []), expressionAt(line, m.index + m[0].length).expr]);
    }
    for (const line of text) {
      for (const m of line.matchAll(READ_CALL)) {
        for (const raw of pathsOf(expressionAt(line, m.index + m[0].length).expr, from, bindings)) {
          const segs = raw.split("/");
          const magic = segs.findIndex((s) => /[*?[{]/.test(s));
          const path = fold(magic === -1 ? segs : segs.slice(0, magic));
          if (!path) continue;
          if (known.has(path)) link(from, path, path);
          else for (const f of known) if (f.startsWith(`${path}/`)) link(from, f, `${path}/`);
        }
      }
    }
  }
  return by;
}

/** `git grep` output, or "" when nothing matches (git grep exits 1). */
async function grepOrNone(git: TrustedGit, args: string[]): Promise<string> {
  try {
    return await git(["grep", ...args]);
  } catch {
    return "";
  }
}

/**
 * The selection for the branch's diff against `baseSha` (the three-dot diff the scope gate reads). A changed file on
 * the full list (a hub, a package file, a test setup file, vitest.config.ts or a tsconfig*.json): full. Otherwise each
 * changed test file is picked, and each changed file's importers are walked: a test importer is picked, a hub is
 * neither picked nor walked, any other is walked further. Each changed file's readers under tests/ (readersOf) are
 * treated the same way, named in `reads`. The always-run list is added.
 */
export async function selectTests(git: TrustedGit, baseSha: string, cfg: TestSelectionConfig): Promise<TestSelection> {
  const changed = (await git(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`])).split("\0").filter(Boolean).sort();
  for (const p of changed) {
    const reason = fullReason(p, cfg.hubs);
    if (reason) return { full: true, reason };
  }
  const sources = changed.filter(inGraph);
  if (sources.length === 0) {
    return { full: false, files: [...cfg.always], reason: `${cfg.always.length} files, no source or test file changed: the always-run list only`, changed };
  }
  const tracked = new Set((await git(["ls-files", "-z", "--", ...GRAPH_ROOTS])).split("\0").filter(Boolean));
  // A deleted file is no longer tracked, yet its importers and readers still name it.
  const known = new Set([...tracked, ...sources]);
  const importers = importersOf(await grepOrNone(git, ["-z", "-I", "-E", GREP_PATTERN, "--", ...GRAPH_ROOTS]), known);
  // The read scan: one grep lists the files under tests/ making a read call, one more returns their lines.
  const reading = (await grepOrNone(git, ["-l", "-z", "-I", "-E", READ_PATTERN, "--", "tests/"])).split("\0").filter(Boolean);
  const readers = reading.length === 0 ? new Map<string, Map<string, string>>() : readersOf(await grepOrNone(git, ["-z", "-I", "-E", READ_LINES, "--", ...reading]), known);
  const picked = new Set(sources.filter((p) => isTest(p) && tracked.has(p)));
  const seen = new Set(sources);
  const queue = [...sources];
  // A read reaches only the text of the file it reads, so only a changed file's readers are picked or walked.
  const reads: ReadPick[] = [];
  for (const file of sources) {
    for (const [from, path] of readers.get(file) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      if (isTest(from)) {
        picked.add(from);
        reads.push({ test: from, path });
      } else if (!cfg.hubs.includes(from)) queue.push(from);
    }
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const from of importers.get(next) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      if (isTest(from)) picked.add(from);
      else if (!cfg.hubs.includes(from)) queue.push(from);
    }
  }
  const reached = [...picked].sort();
  const files = [...reached, ...cfg.always.filter((a) => !picked.has(a))];
  const reason = `${files.length} files, ${reached.length} reaching the ${sources.length} changed source and test files, plus ${cfg.always.length} always-run`;
  reads.sort((a, b) => (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
  return { full: false, files, reason, changed, ...(reads.length > 0 ? { reads } : {}) };
}

const repoRelative = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.startsWith("/") && !v.includes("\\") && v.split("/").every((seg, i, all) => seg !== "." && seg !== ".." && (seg !== "" || i === all.length - 1));

/**
 * `repo.test_selection` (design §4, test selection): absent → nothing (every check runs whole). Otherwise an object
 * with `hubs`, a list of repo-relative files, and `always`, a list of repo-relative files or prefixes ending in `/`,
 * and no other key; any other value fails startup naming the key. The selection names vitest test files after
 * `npm test --`, so with a `testCommand` whose first word is not npm (e.g. `./gradlew test`) startup fails too.
 */
export function testSelectionConfig(value: unknown, testCommand?: readonly string[]): { test_selection?: TestSelectionConfig } {
  if (value === undefined) return {};
  if (testCommand !== undefined && testCommand[0] !== "npm") {
    throw new Error(
      `repo.test_selection needs an npm test command (e.g. repo.test_command ["npm", "test"]); repo.test_command is ${JSON.stringify(testCommand)}. ` +
        "Remove repo.test_selection: a non-npm test command runs whole.",
    );
  }
  const example = '{ "hubs": ["src/compose.ts"], "always": ["tests/architecture/", "tests/boundaries.test.ts"] }';
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`repo.test_selection must be an object with hubs and always lists, e.g. ${example}`);
  const { hubs, always, ...rest } = value as { hubs?: unknown; always?: unknown };
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`repo.test_selection has unknown keys ${extra.join(", ")}; valid keys: hubs, always`);
  if (!Array.isArray(hubs) || !hubs.every((h) => repoRelative(h) && !h.endsWith("/"))) {
    throw new Error(`repo.test_selection.hubs must be a list of repo-relative files, e.g. ["src/compose.ts"]`);
  }
  if (!Array.isArray(always) || !always.every(repoRelative)) {
    throw new Error(`repo.test_selection.always must be a list of repo-relative files or prefixes ending in /, e.g. ["tests/architecture/"]`);
  }
  return { test_selection: { hubs: [...hubs] as string[], always: [...always] as string[] } };
}

/** Whether the check before push narrows the test command (enforce) or runs it whole and records the selection (shadow). */
export type SelectionMode = "shadow" | "enforce";
/** Clean runs in a row in shadow mode before the mode becomes enforce (RFC 0023 §4). */
export const ENFORCE_AFTER = 50;
/** The learned setting holding a project's mode (JSON "enforce" or "shadow"); none is shadow. Each switch is its change row. */
export const MODE_KEY = "test_selection_mode";
/** The actor of a switch's change row. */
export const SELECTION_ACTOR = "system:test-selection";
/** The store cursor holding a project's clean runs in a row: a counter, so 50 writes do not fill the settings history. */
export const cleanCursor = (project: string) => `test_selection_clean:${project}`;

/** What a run records of its selection; a miss adds the failing files the selection left out and the diff's files. */
export interface SelectionRecord {
  mode: SelectionMode;
  full: boolean;
  files: string[];
  reason: string;
  misses?: string[];
  changed?: string[];
}

/** The `failing` test files that `selected` (files, and always-run prefixes ending in `/`) does not cover. */
export function uncovered(selected: readonly string[], failing: readonly string[]): string[] {
  return failing.filter((f) => !selected.some((s) => s === f || (s.endsWith("/") && f.startsWith(s))));
}

/** A run that ran the whole test command in shadow mode (clean or miss), or a miss the merge check caught (merge_miss). */
export type SelectionEvent = "clean" | "miss" | "merge_miss";

/**
 * The mode rule: in shadow mode a clean run adds one, and the ENFORCE_AFTER-th switches to enforce. Any miss means
 * shadow with the count reset. In enforce mode the full command does not run before push, so a clean run changes
 * nothing there, and the merge check's miss is the one that switches back.
 */
export function nextMode(now: { mode: SelectionMode; clean: number }, event: SelectionEvent): { mode: SelectionMode; clean: number } {
  if (event === "merge_miss" || event === "miss") return { mode: "shadow", clean: 0 };
  if (now.mode === "enforce") return now;
  return now.clean + 1 >= ENFORCE_AFTER ? { mode: "enforce", clean: 0 } : { mode: "shadow", clean: now.clean + 1 };
}

type ModeStore = Pick<FactoryStore, "getLearnedSetting" | "setLearnedSetting" | "getCursor" | "advanceCursor">;

/** A project's stored mode; none, or a value that is not "enforce", is shadow. */
export async function selectionMode(store: Pick<FactoryStore, "getLearnedSetting">, project: string): Promise<SelectionMode> {
  const row = await store.getLearnedSetting(project, MODE_KEY);
  return row?.value === JSON.stringify("enforce") ? "enforce" : "shadow";
}

/**
 * Applies `event` to the project's stored mode and count (nextMode): a switch is a learned-setting write with `run_id`
 * as its evidence, the count a cursor write. Both are conditional; a lost race reads again (three tries). Returns the
 * new mode when this call switched it, else null.
 */
export async function noteSelection(d: { store: ModeStore; clock: { now(): Date } }, project: string, event: SelectionEvent, run_id: RunId): Promise<SelectionMode | null> {
  for (let i = 0; i < 3; i++) {
    const row = await d.store.getLearnedSetting(project, MODE_KEY);
    const mode: SelectionMode = row?.value === JSON.stringify("enforce") ? "enforce" : "shadow";
    const raw = await d.store.getCursor(cleanCursor(project));
    const clean = Number.parseInt(raw ?? "0", 10) || 0;
    const next = nextMode({ mode, clean }, event);
    if (next.mode !== mode) {
      const change = await d.store.setLearnedSetting({
        project, key: MODE_KEY, expected: row?.value ?? null, value: JSON.stringify(next.mode), evidence_run_ids: [run_id],
        window_end: d.clock.now().toISOString() as Timestamp, actor: SELECTION_ACTOR,
      });
      if (!change) continue;
    }
    if (next.clean !== clean) {
      const counted = await d.store.advanceCursor(cleanCursor(project), raw, String(next.clean));
      // After a switch a lost count write is harmless: enforce ignores the count, and the switch back resets it.
      if (!counted && next.mode === mode) continue;
    }
    return next.mode !== mode ? next.mode : null;
  }
  return null;
}

/** The selection a run recorded (implement or interactive finish, succeeded: `data.test_selection`); null when none. */
export function recordOf(run: Pick<Run, "outcome">): SelectionRecord | null {
  const r = run.outcome?.status === "succeeded" ? run.outcome.data.test_selection : undefined;
  if (typeof r !== "object" || r === null) return null;
  const { mode, full, files } = r as Partial<SelectionRecord>;
  if ((mode !== "shadow" && mode !== "enforce") || typeof full !== "boolean" || !Array.isArray(files)) return null;
  return r as SelectionRecord;
}

/**
 * The merge check's part (RFC 0023 §4 revert): failing test files on the merged result that the item's last recorded
 * selection, run in enforce mode and narrowed, left out are a miss. It switches the project back to shadow and resets
 * the count. Returns the missed files for the red result, or nothing.
 */
export async function mergeMiss(
  d: { store: ModeStore & Pick<FactoryStore, "listRuns">; clock: { now(): Date } }, item: Pick<WorkItem, "id" | "project">, failing: readonly string[], run_id: RunId,
): Promise<{ selection_miss?: string[] }> {
  if (failing.length === 0) return {};
  const rec = (await d.store.listRuns(item.id)).map(recordOf).filter((r) => r !== null).at(-1);
  if (!rec || rec.mode !== "enforce" || rec.full) return {};
  const missed = uncovered(rec.files, failing);
  if (missed.length === 0) return {};
  await noteSelection(d, item.project, "merge_miss", run_id);
  return { selection_miss: missed };
}
