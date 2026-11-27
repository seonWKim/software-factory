import { describe, expect, it } from "vitest";
import { caseTally, lineDiff, skillVersionRows } from "../src/core/skill-eval-compare.js";
import type { Timestamp } from "../src/core/types.js";

describe("the pure reads", () => {
  it("caseTally counts only cases with a pass or fail in both versions and gives pairedVerdict's verdict", () => {
    const n = (k: number, a: string | null, b: string | null) => Array.from({ length: k }, (_, i) => ({ case_id: `${a}-${b}-${i}`, a, b }));
    expect(caseTally([...n(1, "fail", "pass"), ...n(1, "pass", "fail"), ...n(2, "pass", "pass"), ...n(1, "fail", "fail"), ...n(1, null, "pass"), ...n(1, "errored", "fail")]))
      .toEqual({ wins: 1, losses: 1, ties: 3, verdict: "within noise" });
    expect(caseTally(n(8, "fail", "pass"))).toEqual({ wins: 8, losses: 0, ties: 0, verdict: "better" });
    expect(caseTally(n(8, "pass", "fail"))).toEqual({ wins: 0, losses: 8, ties: 0, verdict: "worse" });
    expect(caseTally([...n(2, null, "pass"), ...n(1, "pass", null)])).toEqual({ wins: 0, losses: 0, ties: 0, verdict: null });
  });

  it("lineDiff keeps unchanged lines and marks removed lines before added ones", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "same", text: "a" }, { op: "removed", text: "b" }, { op: "added", text: "x" }, { op: "same", text: "c" },
    ]);
  });

  it("skillVersionRows gives a null change when the previous version has no pass rate", () => {
    const v = (version: number, folder_hash: string) => ({ version, folder_hash, created_at: `2026-11-2${version}T00:00:00.000Z` });
    const run = (id: string, skill_version: string | null, pass_rate: number | null) => ({ id, started_at: "2026-11-25T00:00:00.000Z" as Timestamp, skill_version, pass_rate });
    const rows = skillVersionRows([v(1, "h1"), v(2, "h2")], [run("r2", "h2", 0.5)]);
    expect(rows.map((r) => [r.version, r.current, r.pass_rate, r.change])).toEqual([[2, true, 0.5, null], [1, false, null, null]]);
  });

  it("skillVersionRows marks the newest version whose gate passed or that has no gate, and no version when none is", () => {
    const v = (version: number, gate: "pending" | "held" | "passed" | "rejected" | null) => ({ version, folder_hash: `h${version}`, created_at: "2026-11-25T00:00:00.000Z", gate });
    const current = (vs: ReturnType<typeof v>[]) => skillVersionRows(vs, []).filter((r) => r.current).map((r) => r.version);
    expect(current([v(1, null), v(2, "passed"), v(3, "held")])).toEqual([2]);
    expect(current([v(1, "passed"), v(2, "rejected"), v(3, "pending")])).toEqual([1]);
    expect(current([v(1, null), v(2, "held")])).toEqual([1]);
    expect(current([v(1, "held"), v(2, "pending")])).toEqual([]);
  });
});
