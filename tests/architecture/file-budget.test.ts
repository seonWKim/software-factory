import { describe, it } from "vitest";
import { ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 file-budget: no src/ file over BUDGET lines; files over it are listed with their line count,
// which may only fall. Raised 100× (600 → 60,000) by the owner for the duration of the refactor, so moving
// legacy files is not blocked by their size; M11 sets it back to 600 and relists the big files.

const BUDGET = 60_000;

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
