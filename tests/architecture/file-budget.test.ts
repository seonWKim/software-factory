import { describe, it } from "vitest";
import { ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 file-budget: no src/ file over 600 lines. Today's big files are listed with their line
// count, which may only fall.

const BUDGET = 600;

describe("file-budget", () => {
  it(`no src/ file grows past ${BUDGET} lines (ratchet)`, () => {
    const over: Record<string, number> = {};
    for (const file of sourceFiles()) {
      const lines = read(file).split("\n").length;
      if (lines > BUDGET) over[file] = lines;
    }
    ratchetCounts("file-budget", over);
  });
});
