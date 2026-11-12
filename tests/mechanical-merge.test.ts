import { describe, expect, it } from "vitest";
import { type MergeIO, appendMerge, mergeAppendedConflicts } from "../src/core/mechanical.js";

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

describe("appended-line merge (design §5, issue #297)", () => {
  it("History lines both sides appended: base lines, then branch lines", () => {
    const ancestor = lines("# 5. Coordination", "", "## History", "", "- old");
    const base = lines("# 5. Coordination", "", "## History", "", "- old", "- from base");
    const branch = lines("# 5. Coordination", "", "## History", "", "- old", "- from branch");
    expect(appendMerge(ancestor, base, branch)).toBe(lines("# 5. Coordination", "", "## History", "", "- old", "- from base", "- from branch"));
  });

  it("index lines added in the middle, and new step lines in different places, keep their places", () => {
    const ancestor = lines("- a", "- c", "- e");
    const base = lines("- a", "- b1", "- c", "- e", "- f1");
    const branch = lines("- a", "- b2", "- c", "- d2", "- e");
    expect(appendMerge(ancestor, base, branch)).toBe(lines("- a", "- b1", "- b2", "- c", "- d2", "- e", "- f1"));
  });

  it("the same lines added on both sides are kept once", () => {
    expect(appendMerge(lines("a"), lines("a", "x"), lines("a", "x"))).toBe(lines("a", "x"));
  });

  it("a removed or changed line on either side is not mechanical", () => {
    expect(appendMerge(lines("a", "b"), lines("a", "b", "c"), lines("a", "B"))).toBeNull();
    expect(appendMerge(lines("a", "b"), lines("a"), lines("a", "b", "c"))).toBeNull();
  });

  it("a side that changed nothing, or a different final newline, is not mechanical", () => {
    expect(appendMerge(lines("a"), lines("a"), lines("a", "b"))).toBeNull();
    expect(appendMerge(lines("a"), "a\nb", lines("a", "c"))).toBeNull();
    // Without a final newline anywhere it still merges.
    expect(appendMerge("a", "a\nb", "a\nc")).toBe("a\nb\nc");
  });

  /** An index in memory: stages per conflicted path, and what each write staged. */
  function memoryIO(stages: Record<string, [string | null, string | null, string | null]>) {
    const written: Record<string, string> = {};
    const io: MergeIO = {
      stage: async (path, n) => (n === 0 ? written[path] ?? null : stages[path]?.[n - 1] ?? null),
      write: async (path, text) => void (written[path] = text),
    };
    return { io, written };
  }

  it("every conflicted file appendable: each is merged and staged, with no model call", async () => {
    const m = memoryIO({
      "docs/design.md": [lines("- a"), lines("- a", "- branch"), lines("- a", "- base")],
      "docs/design/05-coordination.md": [lines("## History"), lines("## History", "- b"), lines("## History", "- a")],
    });
    expect(await mergeAppendedConflicts(m.io, ["docs/design.md", "docs/design/05-coordination.md"])).toBe(true);
    expect(m.written).toEqual({
      "docs/design.md": lines("- a", "- base", "- branch"),
      "docs/design/05-coordination.md": lines("## History", "- a", "- b"),
    });
  });

  it("all or nothing: one file that is not appendable, or a missing stage, writes nothing", async () => {
    const bad = memoryIO({
      "docs/design.md": [lines("- a"), lines("- a", "- branch"), lines("- a", "- base")],
      "src/core/x.ts": [lines("a"), lines("A"), lines("a", "b")],
    });
    expect(await mergeAppendedConflicts(bad.io, ["docs/design.md", "src/core/x.ts"])).toBe(false);
    expect(bad.written).toEqual({});
    // Both sides added the file (no ancestor), or one deleted it.
    expect(await mergeAppendedConflicts(memoryIO({ "n.md": [null, "x\n", "y\n"] }).io, ["n.md"])).toBe(false);
    expect(await mergeAppendedConflicts(memoryIO({ "n.md": ["x\n", null, "x\ny\n"] }).io, ["n.md"])).toBe(false);
    expect(await mergeAppendedConflicts(memoryIO({}).io, [])).toBe(false);
  });
});
