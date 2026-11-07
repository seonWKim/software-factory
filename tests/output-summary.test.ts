import { describe, expect, it } from "vitest";
import { toolchainMissing } from "../src/core/checks.js";
import { failingTests, firstErrorLine, stripAnsi } from "../src/core/output-summary.js";

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
});
