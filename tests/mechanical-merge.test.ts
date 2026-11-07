import { describe, expect, it } from "vitest";
import {
  type MergeIO,
  appendMerge,
  applyRenumbering,
  mergeAppendedConflicts,
  renameStepRefs,
  renumberPlan,
  staleStepRefs,
  stepFile,
  touchesSqliteSchema,
} from "../src/core/mechanical.js";

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
  function memoryIO(stages: Record<string, [string | null, string | null, string | null]>, tree: Record<string, string> = {}) {
    const written: Record<string, string> = {};
    const moves: string[] = [];
    const io: MergeIO = {
      stage: async (path, n) => (n === 0 ? written[path] ?? tree[path] ?? null : stages[path]?.[n - 1] ?? null),
      write: async (path, text) => void (written[path] = text),
      move: async (from, to) => {
        moves.push(`${from} → ${to}`);
        tree[to] = tree[from]!;
        delete tree[from];
      },
    };
    return { io, written, moves };
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

describe("migration renumbering (design §5, issue #297)", () => {
  const base = ["migrations/mysql/0024-item-thread.sql", "migrations/mysql/0025-from-base.sql", "migrations/mysql/README.md"];

  it("reads step files only", () => {
    expect(stepFile("migrations/mysql/0025-a-b.sql")).toEqual({ number: 25, rest: "a-b.sql" });
    expect(stepFile("migrations/mysql/0026-data.ts")).toEqual({ number: 26, rest: "data.ts" });
    expect(stepFile("migrations/mysql/README.md")).toBeNull();
    expect(stepFile("migrations/sqlite/0025-a.sql")).toBeNull();
  });

  it("a new step whose number the base took moves to the next free number; later new steps follow in order", () => {
    expect(renumberPlan(base, ["migrations/mysql/0025-mine.sql"])).toEqual([
      { from: "migrations/mysql/0025-mine.sql", to: "migrations/mysql/0026-mine.sql" },
    ]);
    expect(renumberPlan(base, ["migrations/mysql/0026-second.ts", "migrations/mysql/0025-first.sql"])).toEqual([
      { from: "migrations/mysql/0025-first.sql", to: "migrations/mysql/0026-first.sql" },
      { from: "migrations/mysql/0026-second.ts", to: "migrations/mysql/0027-second.ts" },
    ]);
  });

  it("no collision, no move", () => {
    expect(renumberPlan(base, ["migrations/mysql/0026-mine.sql"])).toEqual([]);
    expect(renumberPlan(base, [])).toEqual([]);
  });

  it("a SQLite schema change in the same branch is detected (renumbering is then skipped)", () => {
    expect(touchesSqliteSchema(["src/impl/store/sqlite/schema.ts", "migrations/mysql/0025-a.sql"])).toBe(true);
    expect(touchesSqliteSchema(["src/impl/store/mysql/schema.ts", "docs/design.md"])).toBe(false);
  });

  it("literal references to the old step name follow; other numbers and longer names do not", () => {
    const plan = [{ from: "migrations/mysql/0025-mine.sql", to: "migrations/mysql/0026-mine.sql" }];
    expect(renameStepRefs("step `migrations/mysql/0025-mine.sql`; 0025-mine; 0025-mine-two; 10025-mine; 0025", plan)).toBe(
      "step `migrations/mysql/0026-mine.sql`; 0026-mine; 0025-mine-two; 10025-mine; 0025",
    );
  });

  it("applying a plan moves the step and rewrites the changed files that name it", async () => {
    const tree: Record<string, string> = {
      "migrations/mysql/0025-mine.sql": "-- 0025-mine\nCREATE TABLE t (id INT);\n",
      "docs/design/05-coordination.md": "MySQL step `migrations/mysql/0025-mine.sql`.\n",
      "lib/a.ts": "export const a = 1;\n",
    };
    const written: Record<string, string> = {};
    const moves: string[] = [];
    const io: MergeIO = {
      stage: async (path, n) => (n === 0 ? written[path] ?? tree[path] ?? null : null),
      write: async (path, text) => void (written[path] = text),
      move: async (from, to) => {
        moves.push(`${from} → ${to}`);
        tree[to] = tree[from]!;
        delete tree[from];
      },
    };
    const plan = renumberPlan(base, ["migrations/mysql/0025-mine.sql"]);
    const edited = await applyRenumbering(io, plan, ["migrations/mysql/0025-mine.sql", "docs/design/05-coordination.md", "lib/a.ts", "gone.md"]);
    expect(moves).toEqual(["migrations/mysql/0025-mine.sql → migrations/mysql/0026-mine.sql"]);
    expect(edited).toEqual(["migrations/mysql/0026-mine.sql", "docs/design/05-coordination.md"]);
    expect(written["docs/design/05-coordination.md"]).toBe("MySQL step `migrations/mysql/0026-mine.sql`.\n");
    expect(written["migrations/mysql/0026-mine.sql"]).toBe("-- 0026-mine\nCREATE TABLE t (id INT);\n");
  });

  it("after a plan, the files whose text still names an old step are listed (a conflicted file the rewrite skipped)", () => {
    const plan = [{ from: "migrations/mysql/0039-sync-lease.sql", to: "migrations/mysql/0040-sync-lease.sql" }];
    const files = [
      { path: "docs/design.md", text: "<<<<<<< HEAD\n- step 0039-sync-lease\n=======\n- other\n>>>>>>> origin/main\n" },
      { path: "docs/a.md", text: "step 0040-sync-lease; 0039-implicit-verdicts\n" },
    ];
    expect(staleStepRefs(files, plan)).toEqual(["docs/design.md"]);
    expect(staleStepRefs(files, [])).toEqual([]);
  });
});
