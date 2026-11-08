import { describe, it } from "vitest";
import { ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 file-budget: no src/ file over BUDGET lines; files over it are listed with their line count,
// which may only fall. It was 60,000 for the refactor (the owner's 100× raise); M11 set it back to 600 and
// relisted the files then over it (2026-11-09).

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
