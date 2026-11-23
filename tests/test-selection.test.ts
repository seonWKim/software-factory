import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckRound, PrePushSelection, selectedChecks } from "../src/core/checks.js";
import type { LearnedSettingChange, SetLearnedSettingInput } from "../src/core/learned-settings.js";
import {
  ENFORCE_AFTER, MODE_KEY, type SelectionMode, type SelectionRecord, cleanCursor, importersOf, mergeMiss, readersOf, nextMode, noteSelection, selectTests, selectionMode,
  testSelectionConfig, uncovered,
} from "../src/core/test-selection.js";
import type { Run, RunId, Timestamp, WorkItemId } from "../src/core/types.js";
import { git, gitTemplate } from "./helpers/git-fixture.js";

// Test selection before push (design §4, decided 2026-11-21), on a fixture repository: which test files the check
// before push runs for a branch's diff, and when it runs the full test command.

const FILES: Record<string, string> = {
  "web/src/views/calendar.tsx": "export const Calendar = () => null;\n",
  // A non-hub file re-exporting the view: its importers are walked further.
  "web/src/views/index.ts": 'export * from "./calendar.js";\n',
  // A hub importing the view: neither picked nor walked, so tests/hubbed.test.ts is not reached through it.
  "src/hub.ts": 'import { Calendar } from "../web/src/views/calendar.js";\nexport const hub = Calendar;\n',
  "src/other.ts": "export const other = 1;\n",
  "tests/calendar.test.tsx": 'import { Calendar } from "../web/src/views/calendar.js";\n',
  "tests/views.test.ts": 'const views = await import("../web/src/views/index.js");\n',
  "tests/mocked.test.ts": 'vi.mock("../web/src/views/index.js");\n',
  "tests/actual.test.ts": 'const real = await vi.importActual<object>("../web/src/views/calendar.js");\n',
  "tests/required.test.ts": 'const m = require("../web/src/views/calendar.js");\n',
  "tests/side.test.ts": 'import "../web/src/views/calendar.js";\n',
  "tests/hubbed.test.ts": 'import { hub } from "../src/hub.js";\n',
  "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
  // A specifier that names no tracked file is ignored.
  "tests/broken.test.ts": 'import { gone } from "./missing.js";\nimport { other } from "../src/other.js";\n',
  "tests/lonely.test.ts": "it.todo('nothing imported');\n",
  "tests/always.test.ts": "\n",
  "tests/arch/a.test.ts": "\n",
  // Type-only lines add no edge: changing the view never selects this test.
  "tests/typed.test.ts": 'import type { Calendar } from "../web/src/views/calendar.js";\nexport type { Calendar as C } from "../web/src/views/calendar.js";\n',
  // Helpers are walked like source files: a change to fixture.ts reaches its importers, directly or through outer.ts.
  "tests/helpers/fixture.ts": "export const f = 1;\n",
  "tests/helpers/outer.ts": 'import { f } from "./fixture.js";\nexport const o = f;\n',
  "tests/uses-fixture.test.ts": 'import { f } from "./helpers/fixture.js";\n',
  "tests/uses-outer.test.ts": 'import { o } from "./helpers/outer.js";\n',
  "tests/setup/root.ts": "export const r = 1;\n",
  "package.json": "{}\n",
  "package-lock.json": "{}\n",
  "vitest.config.ts": "export default {};\n",
  "tsconfig.json": "{}\n",
  "web/tsconfig.json": "{}\n",
  "docs/notes.md": "notes\n",
  // Reads by literal path (design §4, the read rule): the test reaches the file, or every file under the folder.
  "src/read/one.ts": "export const one = 1;\n",
  "src/units/a/a.unit.ts": 'export const a = { reason: "a" };\n',
  "src/units/b.unit.ts": 'export const b = { reason: "b" };\n',
  "tests/reads-one.test.ts": 'import { readFileSync } from "node:fs";\nconst text = readFileSync("src/read/one.ts", "utf8");\n',
  "tests/reads-units.test.ts": [
    'import { readFileSync, readdirSync } from "node:fs";',
    'import { join } from "node:path";',
    "function reasons() {",
    '  const dir = join(import.meta.dirname, "..", "src", "units");',
    "  const files = readdirSync(dir, { recursive: true });",
    '  return files.map((f) => readFileSync(join(dir, String(f)), "utf8"));',
    "}",
    "",
  ].join("\n"),
  "tests/reads-url.test.ts": 'const t = readFileSync(new URL("../src/read/one.ts", import.meta.url), "utf8");\n',
  // A variable path: no edge, as before.
  "tests/reads-variable.test.ts": 'const t = readFileSync(process.argv[2]!, "utf8");\nconst u = existsSync(somewhere);\n',
  // A helper that reads: walked like a helper, so its importer is selected.
  "tests/helpers/reader.ts": 'export const r = () => readFileSync(join("src", "read", "one.ts"), "utf8");\n',
  "tests/uses-reader.test.ts": 'import { r } from "./helpers/reader.js";\n',
};

const CFG = { hubs: ["src/hub.ts"], always: ["tests/arch/", "tests/always.test.ts"] };

const template = gitTemplate((root) => {
  git(root, "init", "--quiet", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
});

/** A copy of the fixture on a branch that changes `paths` (appends a line; null deletes the file); its git reader and base. */
function branch(paths: Record<string, string | null>) {
  const root = template.copy();
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--quiet", "-b", "work");
  for (const [path, text] of Object.entries(paths)) {
    if (text === null) rmSync(join(root, path));
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  }
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "change");
  // Untrimmed: `-z` output ends in NUL.
  const read = async (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { root, base, read };
}

describe("selectTests", () => {
  it("a change to web/src/views/calendar.tsx alone picks exactly the tests that reach it, directly or through non-hub files, plus the always-run list", async () => {
    const b = branch({ "web/src/views/calendar.tsx": "export const Calendar = () => 1;\n" });
    const s = await selectTests(b.read, b.base, CFG);
    expect(s).toEqual({
      full: false,
      files: [
        "tests/actual.test.ts", "tests/calendar.test.tsx", "tests/mocked.test.ts", "tests/required.test.ts", "tests/side.test.ts", "tests/views.test.ts",
        "tests/arch/", "tests/always.test.ts",
      ],
      reason: "8 files, 6 reaching the 1 changed source and test files, plus 2 always-run",
      changed: ["web/src/views/calendar.tsx"],
    });
  });

  it("a change to a hub, a package file, a test setup file, vitest.config.ts or a tsconfig*.json runs the full command, naming why", async () => {
    const cases: [string, string][] = [
      ["src/hub.ts", "full: hub file src/hub.ts changed"],
      ["package.json", "full: package file package.json changed"],
      ["package-lock.json", "full: package file package-lock.json changed"],
      ["tests/setup/root.ts", "full: test setup tests/setup/root.ts changed"],
      ["vitest.config.ts", "full: test config vitest.config.ts changed"],
      ["tsconfig.json", "full: test config tsconfig.json changed"],
      ["web/tsconfig.json", "full: test config web/tsconfig.json changed"],
      ["tsconfig.test.json", "full: test config tsconfig.test.json changed"],
    ];
    for (const [path, reason] of cases) {
      const b = branch({ [path]: "// changed\n", "src/other.ts": "export const other = 2;\n" });
      expect(await selectTests(b.read, b.base, CFG), path).toEqual({ full: true, reason });
    }
  });

  it("a change to a helper under tests/helpers/ selects the tests importing it, directly or through another helper, not the full command", async () => {
    const b = branch({ "tests/helpers/fixture.ts": "export const f = 2;\n" });
    expect(await selectTests(b.read, b.base, CFG)).toMatchObject({
      full: false, files: ["tests/uses-fixture.test.ts", "tests/uses-outer.test.ts", "tests/arch/", "tests/always.test.ts"], changed: ["tests/helpers/fixture.ts"],
    });
  });

  it("a changed test file is picked even when nothing imports it; a deleted source file still reaches its importers", async () => {
    const b = branch({ "tests/lonely.test.ts": "it.todo('changed');\n", "src/other.ts": null });
    const s = await selectTests(b.read, b.base, CFG);
    expect(s).toMatchObject({ full: false, files: ["tests/broken.test.ts", "tests/lonely.test.ts", "tests/other.test.ts", "tests/arch/", "tests/always.test.ts"] });
  });

  it("a change to no source or test file (docs only) runs only the always-run list, and says so", async () => {
    const b = branch({ "docs/notes.md": "more notes\n" });
    expect(await selectTests(b.read, b.base, CFG)).toEqual({
      full: false, files: ["tests/arch/", "tests/always.test.ts"], reason: "2 files, no source or test file changed: the always-run list only", changed: ["docs/notes.md"],
    });
  });

  it("a test reading one source file by literal path is selected when that file changes, naming the read; a helper that reads it is walked", async () => {
    const b = branch({ "src/read/one.ts": "export const one = 2;\n" });
    expect(await selectTests(b.read, b.base, CFG)).toEqual({
      full: false,
      files: ["tests/reads-one.test.ts", "tests/reads-url.test.ts", "tests/uses-reader.test.ts", "tests/arch/", "tests/always.test.ts"],
      reason: "5 files, 3 reaching the 1 changed source and test files, plus 2 always-run",
      changed: ["src/read/one.ts"],
      reads: [{ test: "tests/reads-one.test.ts", path: "src/read/one.ts" }, { test: "tests/reads-url.test.ts", path: "src/read/one.ts" }],
    });
  });

  it("a test reading a literal path is not selected when an unrelated file changes", async () => {
    const b = branch({ "src/other.ts": "export const other = 2;\n" });
    const s = await selectTests(b.read, b.base, CFG);
    expect(s).toEqual({
      full: false, files: ["tests/broken.test.ts", "tests/other.test.ts", "tests/arch/", "tests/always.test.ts"],
      reason: "4 files, 2 reaching the 1 changed source and test files, plus 2 always-run", changed: ["src/other.ts"],
    });
  });

  it("a folder read through a const bound to a join of import.meta.dirname selects the test for a change to any file under that folder", async () => {
    for (const path of ["src/units/b.unit.ts", "src/units/a/a.unit.ts"]) {
      const b = branch({ [path]: "// changed\n" });
      expect(await selectTests(b.read, b.base, CFG), path).toMatchObject({
        full: false, files: ["tests/reads-units.test.ts", "tests/arch/", "tests/always.test.ts"], reads: [{ test: "tests/reads-units.test.ts", path: "src/units/" }],
      });
    }
  });

  it("a test reading a variable path keeps today's selection: only its own change or its imports select it", async () => {
    const b = branch({ "src/read/one.ts": "export const one = 2;\n", "src/units/b.unit.ts": "// changed\n", "src/other.ts": "export const other = 2;\n" });
    const s = await selectTests(b.read, b.base, CFG);
    expect(s.full ? [] : s.files).not.toContain("tests/reads-variable.test.ts");
    const own = branch({ "tests/reads-variable.test.ts": "// changed\n" });
    expect(await selectTests(own.read, own.base, CFG)).toEqual({
      full: false, files: ["tests/reads-variable.test.ts", "tests/arch/", "tests/always.test.ts"],
      reason: "3 files, 1 reaching the 1 changed source and test files, plus 2 always-run", changed: ["tests/reads-variable.test.ts"],
    });
  });

  it("in this repository, a change to src/controller/units/kernel.ts selects tests/item-page.test.tsx, which reads src/controller/units/", async () => {
    const root = join(import.meta.dirname, "..");
    const read = async (args: string[]) =>
      args[0] === "diff" ? "src/controller/units/kernel.ts\0" : execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const s = await selectTests(read, "base", { hubs: [], always: [] });
    expect(s.full ? [] : s.files).toContain("tests/item-page.test.tsx");
    expect(s.full ? [] : s.reads).toContainEqual({ test: "tests/item-page.test.tsx", path: "src/controller/units/" });
  });

  it("an always-run file the diff also reaches is listed once", async () => {
    const b = branch({ "tests/always.test.ts": "// changed\n" });
    expect(await selectTests(b.read, b.base, CFG)).toMatchObject({ full: false, files: ["tests/always.test.ts", "tests/arch/"] });
  });
});

describe("importersOf", () => {
  it("resolves .js specifiers to .ts/.tsx sources and folder imports to index files; drops unresolved and self imports", () => {
    const known = new Set(["src/a.ts", "src/b.tsx", "src/c/index.ts", "tests/t.test.ts"]);
    const grep = [
      'tests/t.test.ts\0from "../src/a.js"', 'tests/t.test.ts\0import("../src/b.js")', 'tests/t.test.ts\0from "../src/c"',
      'tests/t.test.ts\0from "../src/nope.js"', 'src/a.ts\0from "./a.js"', "garbage",
    ].join("\n");
    const by = importersOf(grep, known);
    expect([...by.keys()].sort()).toEqual(["src/a.ts", "src/b.tsx", "src/c/index.ts"]);
    expect([...by.get("src/a.ts")!]).toEqual(["tests/t.test.ts"]);
  });

  it("type-only lines add no edge; every runtime specifier on a line does", () => {
    const known = new Set(["src/a.ts", "src/b.ts", "src/c.ts", "tests/t.test.ts"]);
    const grep = [
      'tests/t.test.ts\0import type { A } from "../src/a.js";', 'tests/t.test.ts\0  export type { A } from "../src/a.js";',
      'tests/t.test.ts\0vi.mock("../src/b.js", () => import("../src/c.js"));',
    ].join("\n");
    expect([...importersOf(grep, known).keys()].sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });
});

describe("readersOf", () => {
  const known = new Set(["src/a.ts", "src/d/b.ts", "src/d/e/c.ts", "web/src/x.css", "tests/t.test.ts"]);
  const scan = (...lines: string[]) => readersOf(lines.map((l) => `tests/t.test.ts\0${l}`).join("\n"), known);
  const linked = (by: Map<string, Map<string, string>>) => [...by].map(([file, from]) => `${file} <- ${[...from.values()].join(" ")}`).sort();

  it("links each literal form: a string, join/resolve of literals, new URL from import.meta.url, a const root, dirname(fileURLToPath(import.meta.url)) and a glob's folder", () => {
    expect(linked(scan('readFileSync("src/a.ts")'))).toEqual(["src/a.ts <- src/a.ts"]);
    expect(linked(scan('await readFile(resolve(import.meta.dirname, "../web/src", "x.css"))'))).toEqual(["web/src/x.css <- web/src/x.css"]);
    expect(linked(scan('existsSync(new URL("../src/d/e/", import.meta.url))'))).toEqual(["src/d/e/c.ts <- src/d/e/"]);
    expect(linked(scan('const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");', 'readdirSync(join(ROOT, "src", "d"))'))).toEqual([
      "src/d/b.ts <- src/d/", "src/d/e/c.ts <- src/d/",
    ]);
    expect(linked(scan('for (const f of glob("src/d/**/*.ts")) {}'))).toEqual(["src/d/b.ts <- src/d/", "src/d/e/c.ts <- src/d/"]);
  });

  it("links nothing for a variable, an expression not built from literals, a path outside the repository or the repository root", () => {
    expect(linked(scan(
      "readFileSync(file)", "readFileSync(join(dir, name))", "readFileSync(`src/${name}.ts`)", 'readFileSync("/etc/hosts")',
      'readFileSync(join(import.meta.dirname, "..", "..", "src", "a.ts"))', 'readdirSync(join(import.meta.dirname, ".."))', 'readFileSync("src/a" + ".ts")',
    ))).toEqual([]);
  });
});

describe("selectedChecks", () => {
  const TYPECHECK = ["npm", "run", "typecheck"];
  const TEST = ["npm", "test"];
  const diffOnly = (files: string[]) => async (args: string[]) => (args[0] === "diff" ? files.map((f) => `${f}\0`).join("") : "");

  it("in enforce mode narrows only the command equal to repo.test_command, appending the files as the base rerun does, and logs the selection", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: [], always: ["tests/arch/"] } };
    const out = await selectedChecks(repo, [TYPECHECK, TEST, ["npm", "run", "lint"]], diffOnly(["docs/a.md"]), "base", (l) => lines.push(l), "enforce");
    expect(out.commands).toEqual([TYPECHECK, ["npm", "test", "--", "tests/arch/"], ["npm", "run", "lint"]]);
    expect(lines).toEqual(["test selection (enforce): 1 files, no source or test file changed: the always-run list only: tests/arch/"]);
  });

  it("in shadow mode every command runs whole; the selection is still made, returned and logged", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: [], always: ["tests/arch/"] } };
    const out = await selectedChecks(repo, [TYPECHECK, TEST], diffOnly(["docs/a.md"]), "base", (l) => lines.push(l), "shadow");
    expect(out.commands).toEqual([TYPECHECK, TEST]);
    expect(out.selection).toMatchObject({ full: false, files: ["tests/arch/"], changed: ["docs/a.md"] });
    expect(lines).toEqual(["test selection (shadow): 1 files, no source or test file changed: the always-run list only: tests/arch/"]);
  });

  it("a full selection leaves the command whole and logs why", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: ["src/compose.ts"], always: [] } };
    expect((await selectedChecks(repo, [TYPECHECK, TEST], diffOnly(["src/compose.ts"]), "base", (l) => lines.push(l), "enforce")).commands).toEqual([TYPECHECK, TEST]);
    expect(lines).toEqual(["test selection (enforce): full: hub file src/compose.ts changed"]);
  });

  it("logs one line per test picked by a read after the reason line, naming the path read (a folder ends in /)", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: [], always: [] } };
    const b = branch({ "src/units/b.unit.ts": "// changed\n", "src/read/one.ts": "export const one = 2;\n" });
    await selectedChecks(repo, [TEST], b.read, b.base, (l) => lines.push(l), "shadow");
    expect(lines).toEqual([
      "test selection (shadow): 4 files, 4 reaching the 2 changed source and test files, plus 0 always-run: tests/reads-one.test.ts tests/reads-units.test.ts tests/reads-url.test.ts tests/uses-reader.test.ts",
      "test selection (shadow): tests/reads-one.test.ts reads src/read/one.ts",
      "test selection (shadow): tests/reads-units.test.ts reads src/units/",
      "test selection (shadow): tests/reads-url.test.ts reads src/read/one.ts",
    ]);
  });

  it("without repo.test_selection every command runs whole and nothing is read or logged", async () => {
    const lines: string[] = [];
    const read = async (): Promise<string> => {
      throw new Error("no git call expected");
    };
    expect(await selectedChecks({ test_command: TEST }, [TYPECHECK, TEST], read, "base", (l) => lines.push(l), "enforce")).toEqual({ commands: [TYPECHECK, TEST], selection: null });
    expect(lines).toEqual([]);
  });

  it("a selection git cannot make runs the full command, logged as full", async () => {
    const lines: string[] = [];
    const read = async (): Promise<string> => {
      throw new Error("fatal: bad revision");
    };
    const repo = { test_command: TEST, test_selection: { hubs: [], always: [] } };
    expect((await selectedChecks(repo, [TEST], read, "base", (l) => lines.push(l), "enforce")).commands).toEqual([TEST]);
    expect(lines).toEqual(["test selection (enforce): full: the selection failed: fatal: bad revision"]);
  });
});

describe("testSelectionConfig", () => {
  it("absent is valid and off; hubs files and always files or prefixes ending in / load", () => {
    expect(testSelectionConfig(undefined)).toEqual({});
    expect(testSelectionConfig({ hubs: ["src/compose.ts"], always: ["tests/architecture/", "tests/boundaries.test.ts"] })).toEqual({
      test_selection: { hubs: ["src/compose.ts"], always: ["tests/architecture/", "tests/boundaries.test.ts"] },
    });
  });

  it("any other value fails naming repo.test_selection", () => {
    const bad: unknown[] = [
      null, [], "src/", { hubs: [] }, { always: [] }, { hubs: [], always: [], extra: 1 },
      { hubs: ["src/"], always: [] }, { hubs: ["/abs.ts"], always: [] }, { hubs: ["../up.ts"], always: [] }, { hubs: [""], always: [] },
      { hubs: [], always: ["tests//x"] }, { hubs: [], always: [1] }, { hubs: "src/compose.ts", always: [] },
    ];
    for (const v of bad) expect(() => testSelectionConfig(v), JSON.stringify(v)).toThrow(/^repo\.test_selection/);
  });
});

/** The store calls the mode needs, in memory: learned values with their change rows, and cursors. */
function fakeModeStore(runs: Run[] = []) {
  const learned = new Map<string, string>();
  const cursors = new Map<string, string>();
  const changes: LearnedSettingChange[] = [];
  return {
    changes, cursors,
    async getLearnedSetting(project: string, key: string) {
      const value = learned.get(`${project}|${key}`);
      return value === undefined ? null : { project, key, value, updated_at: "t" as Timestamp };
    },
    async setLearnedSetting(i: SetLearnedSettingInput) {
      if ((learned.get(`${i.project}|${i.key}`) ?? null) !== i.expected) return null;
      learned.set(`${i.project}|${i.key}`, i.value);
      const c = { seq: changes.length + 1, project: i.project, key: i.key, old_value: i.expected, new_value: i.value, evidence_run_ids: i.evidence_run_ids, window_end: i.window_end, actor: i.actor, at: i.window_end };
      changes.push(c);
      return c;
    },
    async getCursor(name: string) {
      return cursors.get(name) ?? null;
    },
    async advanceCursor(name: string, expected: string | null, next: string) {
      if ((cursors.get(name) ?? null) !== expected) return false;
      cursors.set(name, next);
      return true;
    },
    async listRuns() {
      return runs;
    },
  };
}
const clock = { now: () => new Date("2026-11-21T00:00:00.000Z"), sleep: async () => undefined };
const P = "proj";
const RUN = "run_1" as RunId;

describe("shadow mode: the mode rule", () => {
  it("in shadow mode the 50th clean run in a row switches to enforce, the 49th does not; a miss resets the count", () => {
    expect(ENFORCE_AFTER).toBe(50);
    expect(nextMode({ mode: "shadow", clean: 48 }, "clean")).toEqual({ mode: "shadow", clean: 49 });
    expect(nextMode({ mode: "shadow", clean: 49 }, "clean")).toEqual({ mode: "enforce", clean: 0 });
    expect(nextMode({ mode: "shadow", clean: 49 }, "miss")).toEqual({ mode: "shadow", clean: 0 });
  });

  it("in enforce mode a clean run changes nothing; a merge-check miss goes back to shadow with the count reset", () => {
    expect(nextMode({ mode: "enforce", clean: 0 }, "clean")).toEqual({ mode: "enforce", clean: 0 });
    expect(nextMode({ mode: "enforce", clean: 3 }, "merge_miss")).toEqual({ mode: "shadow", clean: 0 });
  });

  it("a failing file is covered by its own name or by an always-run prefix ending in /", () => {
    expect(uncovered(["tests/a.test.ts", "tests/arch/"], ["tests/a.test.ts", "tests/arch/x.test.ts", "tests/architecture.test.ts", "tests/b.test.ts"]))
      .toEqual(["tests/architecture.test.ts", "tests/b.test.ts"]);
  });
});

describe("shadow mode: the stored switches", () => {
  it("no stored mode is shadow; 49 clean runs only count, the 50th writes one change row to enforce with the run as evidence", async () => {
    const store = fakeModeStore();
    expect(await selectionMode(store, P)).toBe("shadow");
    for (let i = 0; i < ENFORCE_AFTER - 1; i++) expect(await noteSelection({ store, clock }, P, "clean", RUN)).toBeNull();
    expect(store.cursors.get(cleanCursor(P))).toBe("49");
    expect(store.changes).toEqual([]);
    expect(await noteSelection({ store, clock }, P, "clean", "run_50" as RunId)).toBe("enforce");
    expect(await selectionMode(store, P)).toBe("enforce");
    expect(store.changes.map((c) => [c.key, c.old_value, c.new_value, c.evidence_run_ids])).toEqual([[MODE_KEY, null, '"enforce"', ["run_50"]]]);
    expect(store.cursors.get(cleanCursor(P))).toBe("0");
  });

  it("a miss in shadow mode resets the count and writes no change row; a merge-check miss in enforce writes the switch back", async () => {
    const store = fakeModeStore();
    store.cursors.set(cleanCursor(P), "12");
    expect(await noteSelection({ store, clock }, P, "miss", RUN)).toBeNull();
    expect(store.cursors.get(cleanCursor(P))).toBe("0");
    expect(store.changes).toEqual([]);
    await store.setLearnedSetting({ project: P, key: MODE_KEY, expected: null, value: '"enforce"', evidence_run_ids: [], window_end: "w" as Timestamp, actor: "a" });
    store.cursors.set(cleanCursor(P), "3");
    expect(await noteSelection({ store, clock }, P, "merge_miss", RUN)).toBe("shadow");
    expect(store.changes.at(-1)).toMatchObject({ old_value: '"enforce"', new_value: '"shadow"', evidence_run_ids: [RUN] });
    expect(store.cursors.get(cleanCursor(P))).toBe("0");
  });

  it("a count another worker moved meanwhile is read again, not overwritten", async () => {
    const store = fakeModeStore();
    const advance = store.advanceCursor.bind(store);
    let raced = false;
    store.advanceCursor = async (name, expected, next) => {
      if (!raced) {
        raced = true;
        store.cursors.set(name, "5"); // the other worker's count lands first
      }
      return advance(name, expected, next);
    };
    await noteSelection({ store, clock }, P, "clean", RUN);
    expect(store.cursors.get(cleanCursor(P))).toBe("6");
  });
});

describe("shadow mode: one check before push (PrePushSelection)", () => {
  const TEST = ["npm", "test"];
  const repo = { test_command: TEST, test_selection: { hubs: [], always: ["tests/arch/"] } };
  const docsOnly = async (args: string[]) => (args[0] === "diff" ? "docs/a.md\0" : "");
  const round = (ok: boolean, tail = "", command = TEST): CheckRound => {
    const r = { command, ok, how: ok ? "passed" : "exited 1", tail };
    return { results: [r], failed: ok ? null : r };
  };
  const open = async (mode?: SelectionMode) => {
    const store = fakeModeStore();
    if (mode) await store.setLearnedSetting({ project: P, key: MODE_KEY, expected: null, value: JSON.stringify(mode), evidence_run_ids: [], window_end: "w" as Timestamp, actor: "a" });
    const lines: string[] = [];
    return { store, lines, sel: await PrePushSelection.open(store, repo, P, (l) => lines.push(l)) };
  };

  it("shadow: the failing test files of the whole command outside the selection are misses, recorded with the changed files; the run resets the count", async () => {
    const { store, lines, sel } = await open();
    expect(await sel.commands([TEST], docsOnly, "base")).toEqual([TEST]);
    sel.saw(round(false, " FAIL  tests/arch/a.test.ts > in\n FAIL  tests/far.test.ts > out\n"));
    expect(sel.record()).toEqual({
      mode: "shadow", full: false, files: ["tests/arch/"], reason: "1 files, no source or test file changed: the always-run list only",
      misses: ["tests/far.test.ts"], changed: ["docs/a.md"],
    });
    store.cursors.set(cleanCursor(P), "9");
    await sel.note({ store, clock }, P, RUN);
    expect(store.cursors.get(cleanCursor(P))).toBe("0");
    expect(lines).toContain("test selection miss: tests/far.test.ts (changed: docs/a.md)");
  });

  it("shadow: a failure inside the selection is no miss and the run counts clean; a run whose test command never ran is not counted", async () => {
    const inside = await open();
    await inside.sel.commands([TEST], docsOnly, "base");
    inside.sel.saw(round(false, " FAIL  tests/arch/a.test.ts > in\n"));
    expect(inside.sel.record()).not.toHaveProperty("misses");
    await inside.sel.note({ store: inside.store, clock }, P, RUN);
    expect(inside.store.cursors.get(cleanCursor(P))).toBe("1");

    const typecheckOnly = await open();
    await typecheckOnly.sel.commands([["npm", "run", "typecheck"], TEST], docsOnly, "base");
    typecheckOnly.sel.saw(round(false, "error TS2322", ["npm", "run", "typecheck"]));
    await typecheckOnly.sel.note({ store: typecheckOnly.store, clock }, P, RUN);
    expect(typecheckOnly.store.cursors.get(cleanCursor(P))).toBeUndefined();
  });

  it("enforce: the test command runs on the selection only, and the run is not counted", async () => {
    const { store, sel } = await open("enforce");
    expect(await sel.commands([TEST], docsOnly, "base")).toEqual([["npm", "test", "--", "tests/arch/"]]);
    sel.saw(round(true, "", ["npm", "test", "--", "tests/arch/"]));
    await sel.note({ store, clock }, P, RUN);
    expect(store.cursors.get(cleanCursor(P))).toBeUndefined();
    expect(sel.record()).toMatchObject({ mode: "enforce", files: ["tests/arch/"] });
  });
});

describe("shadow mode: the merge check's miss (mergeMiss)", () => {
  const item = { id: "wi_1" as WorkItemId, project: P };
  const finished = (rec: SelectionRecord | null): Run => ({ outcome: { status: "succeeded", summary: "s", data: rec ? { test_selection: rec } : {} } }) as Run;
  const enforced: SelectionRecord = { mode: "enforce", full: false, files: ["tests/a.test.ts", "tests/arch/"], reason: "r" };

  it("a failing file the item's last enforced, narrowed selection left out switches the project back to shadow", async () => {
    const store = fakeModeStore([finished({ ...enforced, files: ["tests/old.test.ts"] }), finished(enforced), finished(null)]);
    await store.setLearnedSetting({ project: P, key: MODE_KEY, expected: null, value: '"enforce"', evidence_run_ids: [], window_end: "w" as Timestamp, actor: "a" });
    expect(await mergeMiss({ store, clock }, item, ["tests/a.test.ts", "tests/arch/x.test.ts", "tests/b.test.ts"], RUN)).toEqual({ selection_miss: ["tests/b.test.ts"] });
    expect(await selectionMode(store, P)).toBe("shadow");
  });

  it("no miss when the selection covered every failing file, ran in shadow mode, was full, or none was recorded", async () => {
    const cases: [string, SelectionRecord | null, string][] = [
      ["covered", enforced, "tests/a.test.ts"],
      ["shadow", { ...enforced, mode: "shadow" }, "tests/b.test.ts"],
      ["full", { ...enforced, full: true, files: [] }, "tests/b.test.ts"],
      ["none recorded", null, "tests/b.test.ts"],
    ];
    for (const [name, rec, failing] of cases) {
      const store = fakeModeStore([finished(rec)]);
      await store.setLearnedSetting({ project: P, key: MODE_KEY, expected: null, value: '"enforce"', evidence_run_ids: [], window_end: "w" as Timestamp, actor: "a" });
      expect(await mergeMiss({ store, clock }, item, [failing], RUN), name).toEqual({});
      expect(await selectionMode(store, P), name).toBe("enforce");
    }
  });
});
