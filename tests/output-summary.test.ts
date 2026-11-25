import { describe, expect, it } from "vitest";
import { failingTestFiles, toolchainMissing } from "../src/core/checks.js";
import { failingTestDetails, failingTests, failingTestsAndSuites, firstErrorLine, stripAnsi } from "../src/core/output-summary.js";

// What a person reads first in a failure comment (issue #229).
describe("output summary", () => {
  const vitest = [
    "\u001b[31m FAIL \u001b[39m tests/store-contract.test.ts > mysql > claims a run",
    " FAIL  tests/store-contract.test.ts > mysql > claims a run",
    " FAIL  tests/ui.test.ts > serves the page 12ms",
    "\u001b[31mAssertionError\u001b[39m: expected 1 to be 2",
  ].join("\n");

  it("strips colour and OSC sequences", () => {
    expect(stripAnsi("\u001b[1m\u001b[31mred\u001b[39m\u001b[22m \u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("red link");
    expect(stripAnsi(vitest)).not.toMatch(/\u001b/);
  });

  it("finds the first error line and the failing tests, each once", () => {
    expect(firstErrorLine(vitest)).toBe("FAIL  tests/store-contract.test.ts > mysql > claims a run");
    expect(firstErrorLine("src/a.ts(1,7): error TS2322: Type 'string'…")).toBe("src/a.ts(1,7): error TS2322: Type 'string'…");
    expect(firstErrorLine("all good\nnothing here")).toBeNull();
    expect(failingTests(vitest)).toEqual(["tests/store-contract.test.ts > mysql > claims a run", "tests/ui.test.ts > serves the page"]);
  });

  it("a missing module under node_modules or a missing tool binary is a toolchain failure; a code error is not", () => {
    expect(toolchainMissing("Error: Cannot find module '/w/node_modules/typescript/bin/tsc'\n  code: 'MODULE_NOT_FOUND'")).toContain("node_modules/typescript");
    expect(toolchainMissing("Error: spawnSync /w/node_modules/.bin/tsc ENOENT")).toContain(".bin/tsc");
    expect(toolchainMissing("sh: tsc: command not found")).toContain("tsc");
    expect(toolchainMissing("Error: Cannot find module './missing-file.js'")).toBeNull();
    expect(toolchainMissing("AssertionError: expected 1 to be 2")).toBeNull();
  });

  it("a missing JDK or Gradle is a toolchain failure; a code error with no tool message is not", () => {
    expect(toolchainMissing("> Task :compileJava\nERROR: JAVA_HOME is not set and no 'java' command could be found")).toContain("JAVA_HOME is not set");
    expect(toolchainMissing("sh: gradlew: command not found")).toContain("gradlew: command not found");
    expect(toolchainMissing("bash: gradle: command not found")).toContain("gradle: command not found");
    expect(toolchainMissing("sh: 1: ./gradlew: Permission denied")).toContain("./gradlew: Permission denied");
    expect(toolchainMissing("gradlew: Permission denied")).toContain("gradlew: Permission denied");
    expect(toolchainMissing("zsh: command not found: gradle")).toContain("gradle");
    expect(toolchainMissing("sh: javac: not found")).toContain("javac");
    expect(toolchainMissing("Error: Cannot find module './missing-file.js'")).toBeNull();
    expect(toolchainMissing("error: file Main.java: not found in sources")).toBeNull();
  });
});

// A file vitest fails before its tests run is a failed suite; failing_tests lists it next to failed tests (design 10-event-driven).
describe("failingTestsAndSuites", () => {
  const suiteOnly = [
    "\u001b[31m⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯\u001b[39m",
    "",
    "\u001b[31m FAIL \u001b[39m tests/ui-calendar-page.test.tsx [ tests/ui-calendar-page.test.tsx ]",
    "Error: Cannot bundle Node.js built-in node:sqlite",
    "TypeError: a later error of the same suite",
    "⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    "(node:123) ExperimentalWarning: SQLite is an experimental feature",
  ].join("\n");

  it("one failed suite and no failed test names the file and its first error line", () => {
    expect(failingTestsAndSuites(suiteOnly, 10)).toEqual(["tests/ui-calendar-page.test.tsx > (suite failed): Cannot bundle Node.js built-in node:sqlite"]);
  });

  it("lists failed tests and failed suites in output order, each once, at most `max` in total", () => {
    const mixed = [
      " FAIL  tests/a.test.ts [ tests/a.test.ts ]",
      "⎯⎯⎯⎯⎯⎯⎯[1/3]⎯",
      "Error: after the separator is not this suite's",
      " FAIL  tests/b.test.ts > adds 3ms",
      "AssertionError: expected 1 to be 2",
      " FAIL  tests/c.test.tsx [ tests/c.test.tsx ]",
      "SyntaxError: Unexpected token",
      " FAIL  tests/b.test.ts > adds",
      " FAIL  tests/c.test.tsx [ tests/c.test.tsx ]",
    ].join("\n");
    expect(failingTestsAndSuites(mixed, 10)).toEqual([
      "tests/a.test.ts > (suite failed)",
      "tests/b.test.ts > adds",
      "tests/c.test.tsx > (suite failed): SyntaxError: Unexpected token",
    ]);
    const many = Array.from({ length: 12 }, (_, i) => (i % 2 ? ` FAIL  tests/t${i}.test.ts > case` : ` FAIL  tests/t${i}.test.ts [ tests/t${i}.test.ts ]\nError: ${"x".repeat(400)}`)).join("\n");
    const got = failingTestsAndSuites(many, 10);
    expect(got.map((t) => t.split(" > ")[0])).toEqual(Array.from({ length: 10 }, (_, i) => `tests/t${i}.test.ts`));
    expect(got[0]!.length).toBeLessThanOrEqual(`tests/t0.test.ts > (suite failed): `.length + 300);
  });

  it("failingTestFiles still reads no file from suite-only output, so no rerun or conflict ask changes", () => {
    expect(failingTestFiles(suiteOnly)).toEqual([]);
    expect(failingTests(suiteOnly)).toEqual([]);
  });
});

// The failing tests a CI job's log reports, for the implement run after a second failure (design 05-ci-gate).
describe("failingTestDetails", () => {
  const log = [
    "2026-11-18T08:00:00.0000000Z  ❯ tests/updater.test.ts (3 tests | 1 failed)",
    "2026-11-18T08:00:01.0000000Z \u001b[31m FAIL \u001b[39m tests/updater.test.ts > updater > sweeps orphans",
    "2026-11-18T08:00:01.0000000Z \u001b[31mAssertionError\u001b[39m: expected 1 to be 2 // Object.is equality",
    "2026-11-18T08:00:01.0000000Z ",
    "2026-11-18T08:00:01.0000000Z - Expected",
    "2026-11-18T08:00:01.0000000Z TypeError: a later error of the same test",
    "2026-11-18T08:00:01.0000000Z ⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
    " FAIL  tests/ui.test.ts > serves the page 12ms",
    "",
    " ❯ tests/ui.test.ts:12:5",
    "⎯⎯⎯⎯⎯⎯⎯[2/2]⎯",
    " FAIL  tests/updater.test.ts > updater > sweeps orphans",
    "Error: printed twice",
  ].join("\n");

  it("each failing test once, in order, with its first assertion message (none when it has none)", () => {
    expect(failingTestDetails(log, 10)).toEqual([
      { test: "tests/updater.test.ts > updater > sweeps orphans", message: "AssertionError: expected 1 to be 2 // Object.is equality" },
      { test: "tests/ui.test.ts > serves the page", message: null },
    ]);
  });

  it("keeps at most `max` tests and cuts a long message", () => {
    const many = Array.from({ length: 12 }, (_, i) => ` FAIL  tests/t${i}.test.ts > case\nError: ${"x".repeat(400)}`).join("\n");
    const got = failingTestDetails(many, 10);
    expect(got.map((t) => t.test)).toEqual(Array.from({ length: 10 }, (_, i) => `tests/t${i}.test.ts > case`));
    expect(got[0]!.message!.length).toBeLessThanOrEqual(300);
  });

  it("a log with no vitest FAIL line has none", () => {
    expect(failingTestDetails("npm ERR! lint failed\nError: x", 10)).toEqual([]);
  });
});
