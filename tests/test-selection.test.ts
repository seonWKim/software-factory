import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { importersOf, selectTests, selectedChecks, testSelectionConfig } from "../src/core/test-selection.js";
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
  "tests/helpers/fixture.ts": "export const f = 1;\n",
  "tests/setup/root.ts": "export const r = 1;\n",
  "package.json": "{}\n",
  "package-lock.json": "{}\n",
  "vitest.config.ts": "export default {};\n",
  "tsconfig.json": "{}\n",
  "web/tsconfig.json": "{}\n",
  "docs/notes.md": "notes\n",
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
    });
  });

  it("a change to a hub, a package file, a test helper, vitest.config.ts or a tsconfig*.json runs the full command, naming why", async () => {
    const cases: [string, string][] = [
      ["src/hub.ts", "full: hub file src/hub.ts changed"],
      ["package.json", "full: package file package.json changed"],
      ["package-lock.json", "full: package file package-lock.json changed"],
      ["tests/helpers/fixture.ts", "full: test helper tests/helpers/fixture.ts changed"],
      ["tests/setup/root.ts", "full: test helper tests/setup/root.ts changed"],
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

  it("a changed test file is picked even when nothing imports it; a deleted source file still reaches its importers", async () => {
    const b = branch({ "tests/lonely.test.ts": "it.todo('changed');\n", "src/other.ts": null });
    const s = await selectTests(b.read, b.base, CFG);
    expect(s).toMatchObject({ full: false, files: ["tests/broken.test.ts", "tests/lonely.test.ts", "tests/other.test.ts", "tests/arch/", "tests/always.test.ts"] });
  });

  it("a change to no source or test file (docs only) runs only the always-run list, and says so", async () => {
    const b = branch({ "docs/notes.md": "more notes\n" });
    expect(await selectTests(b.read, b.base, CFG)).toEqual({
      full: false, files: ["tests/arch/", "tests/always.test.ts"], reason: "2 files, no source or test file changed: the always-run list only",
    });
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
});

describe("selectedChecks", () => {
  const TYPECHECK = ["npm", "run", "typecheck"];
  const TEST = ["npm", "test"];
  const diffOnly = (files: string[]) => async (args: string[]) => (args[0] === "diff" ? files.map((f) => `${f}\0`).join("") : "");

  it("narrows only the command equal to repo.test_command, appending the files as the base rerun does, and logs the selection", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: [], always: ["tests/arch/"] } };
    const out = await selectedChecks(repo, [TYPECHECK, TEST, ["npm", "run", "lint"]], diffOnly(["docs/a.md"]), "base", (l) => lines.push(l));
    expect(out).toEqual([TYPECHECK, ["npm", "test", "--", "tests/arch/"], ["npm", "run", "lint"]]);
    expect(lines).toEqual(["test selection: 1 files, no source or test file changed: the always-run list only: tests/arch/"]);
  });

  it("a full selection leaves the command whole and logs why", async () => {
    const lines: string[] = [];
    const repo = { test_command: TEST, test_selection: { hubs: ["src/compose.ts"], always: [] } };
    expect(await selectedChecks(repo, [TYPECHECK, TEST], diffOnly(["src/compose.ts"]), "base", (l) => lines.push(l))).toEqual([TYPECHECK, TEST]);
    expect(lines).toEqual(["test selection: full: hub file src/compose.ts changed"]);
  });

  it("without repo.test_selection every command runs whole and nothing is read or logged", async () => {
    const lines: string[] = [];
    const read = async (): Promise<string> => {
      throw new Error("no git call expected");
    };
    expect(await selectedChecks({ test_command: TEST }, [TYPECHECK, TEST], read, "base", (l) => lines.push(l))).toEqual([TYPECHECK, TEST]);
    expect(lines).toEqual([]);
  });

  it("a selection git cannot make runs the full command, logged as full", async () => {
    const lines: string[] = [];
    const read = async (): Promise<string> => {
      throw new Error("fatal: bad revision");
    };
    const repo = { test_command: TEST, test_selection: { hubs: [], always: [] } };
    expect(await selectedChecks(repo, [TEST], read, "base", (l) => lines.push(l))).toEqual([TEST]);
    expect(lines).toEqual(["test selection: full: the selection failed: fatal: bad revision"]);
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
