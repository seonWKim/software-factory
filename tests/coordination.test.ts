import { describe, expect, it } from "vitest";
import { commandPhase, phaseLabel } from "../src/core/commands.js";
import {
  DEFAULT_COORDINATION,
  type Holder,
  claimDecision,
  coordinationCost,
  dependencyReason,
  dependencyVerdict,
  findCycle,
  holdReason,
  holdsOn,
  learnedWeight,
  parseDependsOn,
  pathWeight,
  sharedPaths,
} from "../src/core/coordination.js";
import { statusOf } from "../src/core/status-label.js";

const S = DEFAULT_COORDINATION;
const none = new Map<string, number>();

describe("coordination cost (design §5, 2026-11-03)", () => {
  it("a shared file weighs 1.0; from two recorded conflicts 1.0 + 0.5 per conflict, at most 4.0", () => {
    expect([0, 1, 2, 3, 4, 6, 10].map(learnedWeight)).toEqual([1, 1, 2, 2.5, 3, 4, 4]);
    const w = (n: number) => pathWeight("lib/x.ts", new Map(n ? [["lib/x.ts", n]] : []), S).weight;
    // Before, after one and after two recorded conflicts.
    expect([w(0), w(1), w(2)]).toEqual([1, 1, 2]);
  });

  it("a hotspot has the fixed configured weight; a learned weight above it wins", () => {
    expect(pathWeight("src/core/worker.ts", none, S)).toEqual({ path: "src/core/worker.ts", weight: 3, conflicts: 0, hotspot: true });
    expect(pathWeight("src/core/worker.ts", new Map([["src/core/worker.ts", 6]]), S).weight).toBe(4);
    expect(pathWeight("SET_UP.md", none, { ...S, hotspot_weight: 5 }).weight).toBe(5);
    // A folder that holds a hotspot counts as one; so does a file under a hotspot folder.
    expect(pathWeight("src/core/", none, S).hotspot).toBe(true);
    expect(pathWeight("gen/a.ts", none, { ...S, hotspots: ["gen/"] }).hotspot).toBe(true);
  });

  it("shared paths use the scope gate's coverage rule; the more specific path is the shared one", () => {
    expect(sharedPaths(["src/", "docs/a.md"], ["src/core/x.ts", "docs/a.md", "tests/"])).toEqual(["docs/a.md", "src/core/x.ts"]);
    expect(sharedPaths(["src/core/"], ["src/"])).toEqual(["src/core/"]);
    expect(sharedPaths(["src/a.ts"], ["src/ab.ts", "src/a"])).toEqual([]);
  });

  it("two ordinary shared files cost 2.0 (parallel at 2.5); a hotspot costs 3.0 (held)", () => {
    expect(coordinationCost(["lib/a.ts", "lib/b.ts"], ["lib/"], none, S).cost).toBe(2);
    expect(coordinationCost(["SET_UP.md"], ["SET_UP.md"], none, S).cost).toBe(3);
    const holder = (kind: Holder["kind"], files: string[], id = "wi_b"): Holder =>
      ({ work_item_id: id, project: "p", ref: "#2", kind, files, fallback: false });
    const cand = { work_item_id: "wi_a", project: "p", files: ["lib/a.ts", "lib/b.ts", "SET_UP.md"] };
    expect(holdsOn(cand, [holder("running", ["lib/"])], none, S)).toEqual([]);
    expect(holdsOn(cand, [holder("pr", ["SET_UP.md"])], none, S).map((h) => h.cost)).toEqual([3]);
    // Not the item itself, not another project.
    expect(holdsOn(cand, [holder("pr", ["SET_UP.md"], "wi_a")], none, S)).toEqual([]);
    expect(holdsOn(cand, [{ ...holder("pr", ["SET_UP.md"]), project: "q" }], none, S)).toEqual([]);
  });

  it("the deadlock rule: held only by waiting runs is claimed; any running item or PR holds", () => {
    const h = (kind: Holder["kind"]) => ({ holder: { work_item_id: "x", project: "p", ref: "#1", kind, files: [], fallback: false }, shared: [], cost: 3 });
    expect(claimDecision([])).toBe("free");
    expect(claimDecision([h("waiting"), h("waiting")])).toBe("deadlock");
    expect(claimDecision([h("waiting"), h("pr")])).toBe("held");
    expect(claimDecision([h("running")])).toBe("held");
  });

  it("running and PR holds come before waiting ones whatever the cost, so the first hold is the one that decides", () => {
    const holder = (kind: Holder["kind"], files: string[], id: string): Holder =>
      ({ work_item_id: id, project: "p", ref: id, kind, files, fallback: false });
    const cand = { work_item_id: "wi_a", project: "p", files: ["SET_UP.md", "src/core/worker.ts", "lib/a.ts"] };
    const holds = holdsOn(cand, [
      holder("waiting", ["SET_UP.md", "src/core/worker.ts", "lib/a.ts"], "wi_queued"), // 7.0
      holder("pr", ["SET_UP.md"], "wi_pr"), // 3.0
      holder("running", ["SET_UP.md", "lib/a.ts"], "wi_running"), // 4.0
    ], none, S);
    expect(holds.map((h) => [h.holder.work_item_id, h.cost])).toEqual([["wi_running", 4], ["wi_pr", 3], ["wi_queued", 7]]);
    expect(claimDecision(holds)).toBe("held");
  });

  it("the hold reason the comment and the dashboard show", () => {
    const shared = [pathWeight("src/core/worker.ts", new Map([["src/core/worker.ts", 6]]), S)];
    expect(holdReason({ holder_ref: "#92", shared, cost: 4, threshold: 2.5, fallback: false })).toBe(
      "waiting for #92 to merge: both change src/core/worker.ts (conflicted 6 times), cost 4.0 > 2.5",
    );
    const two = [pathWeight("SET_UP.md", none, S), pathWeight("lib/a.ts", new Map([["lib/a.ts", 1]]), S), pathWeight("lib/b.ts", none, S)];
    expect(holdReason({ holder_ref: "#7", shared: two, cost: 5, threshold: 2.5, fallback: true })).toBe(
      "waiting for #7 to merge: both change SET_UP.md (hotspot), lib/a.ts (conflicted once) and lib/b.ts, cost 5.0 > 2.5" +
        " (#7 is a PR opened before PR file lists were stored, so its allowed paths were used)",
    );
    expect(holdReason({ holder_ref: "#7", shared: [pathWeight("lib/x.ts", new Map([["lib/x.ts", 3]]), S)], cost: 2.5, threshold: 2.5, fallback: false }))
      .toBe("waiting for #7 to merge: both change lib/x.ts (conflicted 3 times), cost 2.5 ≥ 2.5");
  });
});

describe("mechanical paths (design §5, issue #297)", () => {
  const holder = (files: string[]): Holder => ({ work_item_id: "wi_b", project: "p", ref: "#2", kind: "running", files, fallback: false });

  it("a mechanical path is never a hotspot, even when hotspot_paths lists it, and weighs mechanical_weight", () => {
    expect(S.hotspots).toContain("docs/design.md");
    expect(pathWeight("docs/design.md", none, S)).toEqual({ path: "docs/design.md", weight: 0.25, conflicts: 0, hotspot: false, mechanical: true });
    // A file under a mechanical folder too; a folder that only holds mechanical files is not one.
    expect(pathWeight("migrations/mysql/0025-x.sql", none, S)).toMatchObject({ weight: 0.25, mechanical: true });
    expect(pathWeight("docs/", none, S).mechanical).toBeUndefined();
    expect(pathWeight("docs/design/05-coordination.md", none, { ...S, mechanical_weight: 0.5 }).weight).toBe(0.5);
    // Listed in both: still mechanical.
    expect(pathWeight("lib/gen.ts", none, { ...S, hotspots: ["lib/gen.ts"], mechanical: ["lib/"] })).toMatchObject({ hotspot: false, weight: 0.25 });
  });

  it("a learned weight above mechanical_weight wins; one recorded conflict does not lift it", () => {
    const w = (n: number) => pathWeight("docs/design.md", new Map([["docs/design.md", n]]), S).weight;
    expect([w(1), w(2), w(3), w(10)]).toEqual([0.25, 2, 2.5, 4]);
  });

  it("a step file, a History line and an index line each: 0.5, so the two run side by side", () => {
    const a = ["migrations/mysql/0025-a.sql", "docs/design/05-coordination.md", "docs/design.md", "lib/a.ts"];
    const b = ["migrations/mysql/0025-b.sql", "docs/design/05-coordination.md", "docs/design.md", "lib/b.ts"];
    expect(coordinationCost(a, b, none, S).cost).toBe(0.5);
    expect(claimDecision(holdsOn({ work_item_id: "wi_a", project: "p", files: a }, [holder(b)], none, S))).toBe("free");
  });

  it("two items that both change src/core/controller.ts are still held", () => {
    const holds = holdsOn({ work_item_id: "wi_a", project: "p", files: ["src/core/controller.ts", "docs/design.md"] }, [holder(["src/core/controller.ts", "docs/design.md"])], none, S);
    expect(holds.map((h) => h.cost)).toEqual([3.25]);
    expect(claimDecision(holds)).toBe("held");
  });

  it("the hold reason names each mechanical path with its weight", () => {
    const shared = [pathWeight("docs/design.md", none, S), pathWeight("src/core/controller.ts", none, S)];
    expect(holdReason({ holder_ref: "#92", shared, cost: 3.25, threshold: 2.5, fallback: false })).toBe(
      "waiting for #92 to merge: both change docs/design.md (mechanical, 0.25) and src/core/controller.ts (hotspot), cost 3.25 > 2.5",
    );
    const learned = pathWeight("docs/design.md", new Map([["docs/design.md", 3]]), S);
    expect(holdReason({ holder_ref: "#9", shared: [learned], cost: 2.5, threshold: 2.5, fallback: false })).toBe(
      "waiting for #9 to merge: both change docs/design.md (mechanical, 2.5, conflicted 3 times), cost 2.5 ≥ 2.5",
    );
  });
});

describe("dependencies (design §5, 2026-11-03)", () => {
  it("parses Depends on lines: bare #N completed with the repo, other repos kept, each once", () => {
    const text = "Intro mentions #5 but no line.\nDepends on: #12, #13\n- depends on other/repo#4 and #12\nDepends on nothing\n";
    expect(parseDependsOn(text, "o/r")).toEqual(["o/r#12", "o/r#13", "other/repo#4"]);
    expect(parseDependsOn("Depends on #0", "o/r")).toEqual([]);
  });

  it("finds a cycle through the item, and none without one", () => {
    const graph = new Map([["o/r#1", ["o/r#2"]], ["o/r#2", ["o/r#3"]], ["o/r#3", ["o/r#1"]], ["o/r#4", ["o/r#1"]]]);
    expect(findCycle("o/r#1", graph)).toEqual(["o/r#1", "o/r#2", "o/r#3", "o/r#1"]);
    expect(findCycle("o/r#4", graph)).toBeNull();
  });

  it("a verdict: cycle first, then a dependency closed unmerged, then open ones", () => {
    const g = new Map<string, string[]>();
    expect(dependencyVerdict("o/r#1", [], g)).toEqual({ kind: "clear" });
    expect(dependencyVerdict("o/r#1", [{ depends_on: "o/r#2", state: "merged" }], g)).toEqual({ kind: "clear" });
    expect(dependencyVerdict("o/r#1", [{ depends_on: "o/r#2", state: "open" }, { depends_on: "o/r#3", state: "open" }], g))
      .toEqual({ kind: "wait", open: ["o/r#2", "o/r#3"] });
    expect(dependencyVerdict("o/r#1", [{ depends_on: "o/r#2", state: "open" }, { depends_on: "o/r#3", state: "closed_unmerged" }], g))
      .toEqual({ kind: "closed", dependency: "o/r#3" });
    const cyc = new Map([["o/r#1", ["o/r#2"]], ["o/r#2", ["o/r#1"]]]);
    expect(dependencyVerdict("o/r#1", [{ depends_on: "o/r#2", state: "closed_unmerged" }], cyc).kind).toBe("cycle");
    expect(dependencyReason(["o/r#92"], "o/r#1")).toBe("waiting for #92 to merge");
    expect(dependencyReason(["o/r#92", "x/y#3"], "o/r#1")).toBe("waiting for #92 and x/y#3 to merge");
  });
});

describe("status label and command phase of a hold", () => {
  it("a dependency hold and a cost hold show as implementing, never needs human", () => {
    const dep = { stage: "RUNNING" as const, blocked_on: "dependency" as const, blocked_reason: "waiting for #92 to merge", close_reason: null };
    expect(statusOf(dep)).toBe("implementing");
    // A cost hold keeps blocked_on none: its reason is in the claim decision and the comment.
    expect(statusOf({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, close_reason: null })).toBe("implementing");
    // A dependency closed unmerged or a cycle does need a human.
    expect(statusOf({ ...dep, blocked_on: "human", blocked_reason: "dependency_closed:#92" })).toBe("needs_human");
  });

  it("a dependency hold has its own phase, named in words", () => {
    const phase = commandPhase({ stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #92 to merge", pr_number: null });
    expect(phase).toBe("dependency_hold");
    expect(phaseLabel(phase)).toBe("waiting for a dependency to merge");
  });
});
