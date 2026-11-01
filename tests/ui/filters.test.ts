import { describe, expect, it } from "vitest";
import {
  type FilterRow,
  NO_FILTERS,
  applyFilters,
  facetCounts,
  isFiltered,
  parseFilters,
  runKindOf,
  searchKeys,
} from "../../src/ui/filters.js";

type Row = FilterRow & { name: string };
const row = (name: string, p: Partial<FilterRow>): Row => ({
  name,
  level: "running",
  stage: "RUNNING",
  tier: null,
  kind: null,
  dependents: 0,
  search: searchKeys(`o/r#${name.length}`, name),
  ...p,
});

const rows: Row[] = [
  row("merge", { level: "ready_to_merge", stage: "REVIEW", tier: 2, search: searchKeys("o/r#12", "Merge the gate") }),
  row("approve", { level: "needs_approval", stage: "READY", tier: 3, kind: "triage", search: searchKeys("o/r#7", "Spec for search") }),
  row("failed", { level: "needs_human", stage: "RUNNING", tier: 3, kind: "implement", search: searchKeys("o/r#3", null) }),
  row("running", { level: "running", stage: "RUNNING", tier: 2, kind: "implement", search: searchKeys("o/r#4", "Running item") }),
  row("queued", { level: "queued", stage: "NEW", kind: "triage", search: searchKeys("o/r#5", "Queued item") }),
  row("closed", { level: "closed", stage: "CLOSED", tier: 2, search: searchKeys("o/r#9", "Done item") }),
];

const parse = (qs: string) => {
  const r = parseFilters(new URLSearchParams(qs));
  if (!r.ok) throw new Error(r.error);
  return r.filters;
};
const names = (qs: string) => applyFilters(rows, parse(qs)).map((r) => r.name);

describe("ui filters", () => {
  it("the default hides only CLOSED", () => {
    expect(isFiltered(parse(""))).toBe(false);
    expect(names("")).toEqual(["merge", "approve", "failed", "running", "queued"]);
    expect(names("closed=1")).toContain("closed");
  });

  it("each filter returns its rows", () => {
    expect(names("state=needs")).toEqual(["merge", "approve", "failed"]);
    expect(names("state=queued")).toEqual(["queued"]);
    expect(names("state=closed")).toEqual(["closed"]);
    expect(names("stage=RUNNING")).toEqual(["failed", "running"]);
    expect(names("stage=CLOSED")).toEqual(["closed"]);
    expect(names("tier=2")).toEqual(["merge", "running"]);
    expect(names("kind=implement")).toEqual(["failed", "running"]);
    expect(names("kind=triage&stage=NEW")).toEqual(["queued"]);
    expect(names("unblocks=1")).toEqual([]);
    expect(names("q=%2312")).toEqual(["merge"]);
    expect(names("q=12")).toEqual(["merge"]);
    expect(names("q=ITEM")).toEqual(["running", "queued"]);
  });

  it("'unblocks others' returns the items with dependents", () => {
    const withDeps = rows.map((r) => (r.name === "running" ? { ...r, dependents: 2 } : r));
    expect(applyFilters(withDeps, parse("unblocks=1")).map((r) => r.name)).toEqual(["running"]);
  });

  it("a withheld title is not searchable, its number is", () => {
    expect(names("q=withheld")).toEqual([]);
    expect(names("q=%233")).toEqual(["failed"]);
  });

  it("counts what each option would show, keeping the other filters", () => {
    const c = facetCounts(rows, parse("tier=3"));
    expect(c.allStates).toBe(2);
    expect(c.state.needs).toBe(2);
    expect(c.state.needs_approval).toBe(1);
    expect(c.state.closed).toBe(0);
    expect(c.allTiers).toBe(5);
    expect(c.tier[2]).toBe(2);
    expect(c.tier[3]).toBe(2);
    expect(c.stage.READY).toBe(1);
    expect(c.kind.implement).toBe(1);
    expect(c.unblocks).toBe(0);
    const all = facetCounts(rows, NO_FILTERS);
    expect(all.state.needs).toBe(3);
    expect(all.state.closed).toBe(1);
    expect(all.stage.CLOSED).toBe(1);
    expect(all.tier[2]).toBe(2); // CLOSED stays hidden in the tier count
  });

  it("an unknown value is an error naming the filter", () => {
    for (const [qs, error] of [
      ["state=bogus", "Unknown state."],
      ["stage=BOGUS", "Unknown stage."],
      ["tier=9", "Unknown tier."],
      ["kind=deploy", "Unknown run kind."],
      ["unblocks=yes", "Unknown unblocks value."],
    ] as const) {
      expect(parseFilters(new URLSearchParams(qs))).toEqual({ ok: false, error });
    }
    expect(parse("state=&stage=&tier=&kind=&q=").state).toBeUndefined();
  });

  it("run kind comes from a run_failed reason first, then the active run", () => {
    expect(runKindOf("run_failed:review:x", "implement")).toBe("review");
    expect(runKindOf("max_loops", "implement")).toBe("implement");
    expect(runKindOf(null, null)).toBeNull();
  });
});
