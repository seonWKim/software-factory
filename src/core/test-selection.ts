import { withTestFiles } from "./checks.js";
import type { FactoryConfig } from "./config.js";
import type { TrustedGit } from "./pre-push.js";

// Test selection before push (design §4, decided 2026-11-21): the check before push (the implement run's two
// rounds and the interactive finish) runs the test command on the test files that can reach the branch's changed
// files, plus a fixed always-run list. The merge check runs the full list, so a test this graph cannot see (one
// that reads a file by path, or imports a string built at run time) still runs before a merge.

/** `repo.test_selection`: hand-written hub files (neither picked nor walked) and the always-run files or prefixes. */
export type TestSelectionConfig = NonNullable<FactoryConfig["repo"]["test_selection"]>;

/** Full: the whole test command, and why. Otherwise the test files (and always-run prefixes) to run, and why. */
export type TestSelection = { full: true; reason: string } | { full: false; files: string[]; reason: string };

/** The folders the import graph reads. A changed file under none of them is no source or test file (docs, config). */
const GRAPH_ROOTS = ["src/", "web/src/", "tests/"] as const;
const PACKAGE_FILES = ["package.json", "package-lock.json"];
const TEST_HELPERS = ["tests/helpers/", "tests/setup/"];
const isTestConfig = (p: string) => p === "vitest.config.ts" || /(^|\/)tsconfig[^/]*\.json$/.test(p);
/** A vitest test file, as vitest.config.ts includes them. */
const isTest = (p: string) => p.startsWith("tests/") && /\.test\.tsx?$/.test(p);
const inGraph = (p: string) => GRAPH_ROOTS.some((r) => p.startsWith(r));

/**
 * The relative import specifiers git grep matches: `from "./x"`, `import "./x"`, `import("./x")`, `require("./x")`,
 * `vi.mock("./x")` and `vi.importActual<...>("./x")`. POSIX ERE, so no `\s`.
 */
const GREP_PATTERN = `(from|import|require|vi\\.mock|vi\\.importActual)(<[^>]*>)?[[:space:]]*\\(?[[:space:]]*["']\\.\\.?/[^"']*["']`;
const SPECIFIER = /["'](\.\.?\/[^"']*)["']/;

/** The full-list rule a changed file hits, as the reason; null when it hits none. */
function fullReason(path: string, hubs: readonly string[]): string | null {
  if (hubs.includes(path)) return `full: hub file ${path} changed`;
  if (PACKAGE_FILES.includes(path)) return `full: package file ${path} changed`;
  if (TEST_HELPERS.some((h) => path.startsWith(h))) return `full: test helper ${path} changed`;
  if (isTestConfig(path)) return `full: test config ${path} changed`;
  return null;
}

/** The tracked file `spec` names from `from`, trying the TypeScript sources a `.js` specifier stands for; null when none. */
export function resolveSpecifier(from: string, spec: string, known: ReadonlySet<string>): string | null {
  // The importer's folder joined with the specifier, `.` and `..` segments folded (core/ imports no node: module).
  const parts: string[] = [];
  for (const seg of [...from.split("/").slice(0, -1), ...spec.split("/")]) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const target = parts.join("/");
  const stem = target.replace(/\.(m|c)?jsx?$/, "");
  const tries = [target, `${stem}.ts`, `${stem}.tsx`, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}/index.ts`, `${target}/index.tsx`];
  return tries.find((t) => known.has(t)) ?? null;
}

/** Importer lists by imported file, from `git grep -z -o` output (`path\0match` per line); unresolved specifiers are dropped. */
export function importersOf(grep: string, known: ReadonlySet<string>): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const line of grep.split("\n")) {
    const [from, match] = line.split("\0");
    const spec = match === undefined ? undefined : SPECIFIER.exec(match)?.[1];
    if (!from || !spec) continue;
    const to = resolveSpecifier(from, spec, known);
    if (to === null || to === from) continue;
    const set = by.get(to) ?? new Set<string>();
    set.add(from);
    by.set(to, set);
  }
  return by;
}

/**
 * The selection for the branch's diff against `baseSha` (the three-dot diff the scope gate reads). A changed file on
 * the full list (a hub, a package file, a test helper, vitest.config.ts or a tsconfig*.json): full. Otherwise each
 * changed test file is picked, and each changed file's importers are walked: a test importer is picked, a hub is
 * neither picked nor walked, any other is walked further. The always-run list is added.
 */
export async function selectTests(git: TrustedGit, baseSha: string, cfg: TestSelectionConfig): Promise<TestSelection> {
  const changed = (await git(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`])).split("\0").filter(Boolean).sort();
  for (const p of changed) {
    const reason = fullReason(p, cfg.hubs);
    if (reason) return { full: true, reason };
  }
  const sources = changed.filter(inGraph);
  if (sources.length === 0) {
    return { full: false, files: [...cfg.always], reason: `${cfg.always.length} files, no source or test file changed: the always-run list only` };
  }
  const tracked = new Set((await git(["ls-files", "-z", "--", ...GRAPH_ROOTS])).split("\0").filter(Boolean));
  let grep = "";
  try {
    grep = await git(["grep", "-z", "-o", "-I", "-E", GREP_PATTERN, "--", ...GRAPH_ROOTS]);
  } catch {
    grep = ""; // git grep exits 1 when nothing matches: no imports at all
  }
  // A deleted file is no longer tracked, yet its importers still name it.
  const importers = importersOf(grep, new Set([...tracked, ...sources]));
  const picked = new Set(sources.filter((p) => isTest(p) && tracked.has(p)));
  const seen = new Set(sources);
  const queue = [...sources];
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
  return { full: false, files, reason: `${files.length} files, ${reached.length} reaching the ${sources.length} changed source and test files, plus ${cfg.always.length} always-run` };
}

/**
 * `commands` with the one whose argv equals `repo.test_command` run on the selected files only (appended as the base
 * rerun appends them, withTestFiles); every other command, typecheck included, runs whole. No `repo.test_selection`:
 * `commands` as they are. The selection and its reason go to `log` before any command runs; a selection that cannot
 * be made (git failed) runs the full list.
 */
export async function selectedChecks(
  repo: Pick<FactoryConfig["repo"], "test_command" | "test_selection">, commands: readonly (readonly string[])[], git: TrustedGit, baseSha: string, log: (line: string) => void,
): Promise<string[][]> {
  const same = (c: readonly string[]) => c.length === repo.test_command.length && c.every((a, i) => a === repo.test_command[i]);
  if (!repo.test_selection || !commands.some(same)) return commands.map((c) => [...c]);
  let s: TestSelection;
  try {
    s = await selectTests(git, baseSha, repo.test_selection);
  } catch (err) {
    s = { full: true, reason: `full: the selection failed: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 300) };
  }
  log(`test selection: ${s.reason}${s.full ? "" : `: ${s.files.join(" ")}`}`);
  return commands.map((c) => (same(c) && !s.full ? withTestFiles(c, s.files) : [...c]));
}

const repoRelative = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.startsWith("/") && !v.includes("\\") && v.split("/").every((seg, i, all) => seg !== "." && seg !== ".." && (seg !== "" || i === all.length - 1));

/**
 * `repo.test_selection` (design §4, test selection): absent → nothing (every check runs whole). Otherwise an object
 * with `hubs`, a list of repo-relative files, and `always`, a list of repo-relative files or prefixes ending in `/`,
 * and no other key; any other value fails startup naming the key.
 */
export function testSelectionConfig(value: unknown): { test_selection?: TestSelectionConfig } {
  if (value === undefined) return {};
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
