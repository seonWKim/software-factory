import { describe, expect, it } from "vitest";
import { codeOnly, componentOf, ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 no-clock: handlers never read a clock or set a timer; time comes from a TickGenerator.
// Allowed only in shared/ticks/plugins/ and in bus plugins' transport code. Legacy code (Clock injected
// everywhere) is counted per file and may only fall.

const CLOCK = /\bDate\.now\s*\(|\bnew Date\(\s*\)|\bperformance\.now\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\binterfaces\/clock\.js\b/g;
const ALLOWED = [/^shared\/ticks\/plugins\//, /^bus\/plugins\/[^/]+\/transport\//];

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sourceFiles()) {
    if (ALLOWED.some((a) => a.test(file))) continue;
    const n = codeOnly(read(file)).match(CLOCK)?.length ?? 0;
    if (n > 0) out[file] = n;
  }
  return out;
}

describe("no-clock", () => {
  it("clock reads and timers only fall (ratchet)", () => {
    ratchetCounts("no-clock", counts());
  });

  it("new component code has none at all", () => {
    expect(Object.keys(counts()).filter((f) => componentOf(f) !== null)).toEqual([]);
  });
});
