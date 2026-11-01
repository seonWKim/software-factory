import { describe, expect, it } from "vitest";
import { LEVELS, type PriorityInput, levelOf, rank } from "../../src/ui/priority.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const LEASE = 60_000;
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

type Seed = PriorityInput & { name: string };

function item(name: string, p: Partial<PriorityInput>): Seed {
  return {
    name,
    stage: "RUNNING",
    blocked_on: "none",
    blocked_reason: null,
    close_reason: null,
    tier: null,
    since: at(1),
    run: null,
    dependents: 0,
    waiting_on: 0,
    ...p,
  };
}

const running = (kind: "implement" | "review", beatMinAgo: number) => ({ kind, status: "running" as const, heartbeat_at: at(beatMinAgo) });
const queued = { kind: "triage" as const, status: "queued" as const, heartbeat_at: at(3) };

// Given in shuffled order; `expected` is the order and badges the ranking must produce.
const seeds: Seed[] = [
  item("closed", { stage: "CLOSED", close_reason: "wont_do", since: at(999) }),
  item("waiting", { stage: "READY", waiting_on: 2, since: at(50) }),
  item("queued", { stage: "NEW", run: queued, since: at(3) }),
  item("running", { run: running("implement", 0), since: at(4) }),
  item("stuck-idle", { stage: "REVIEW", since: at(5) }),
  item("stuck-lease", { run: running("review", 12), since: at(30) }),
  item("human-new-tier1", { blocked_on: "human", blocked_reason: "max_loops", tier: 1, since: at(20) }),
  item("human-new-tier3", { blocked_on: "human", blocked_reason: "max_loops", tier: 3, since: at(20) }),
  item("human-old", { blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large", since: at(90) }),
  item("budget", { blocked_on: "budget", blocked_reason: "budget_checkpoint", since: at(10) }),
  item("approval", { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", since: at(2) }),
  item("merge-old", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", since: at(60) }),
  item("merge-new-unblocks", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", since: at(1), dependents: 2 }),
];

const expected: [string, string[]][] = [
  ["merge-new-unblocks", ["ready to merge", "unblocks 2"]], // more dependents beat an older wait
  ["merge-old", ["ready to merge"]],
  ["approval", ["needs approval"]],
  ["human-old", ["failed"]], // oldest wait first
  ["human-new-tier3", ["too many loops"]], // same wait: higher tier first
  ["human-new-tier1", ["too many loops"]],
  ["budget", ["budget check"]],
  ["stuck-lease", ["stuck 12 min"]], // minutes since the last heartbeat
  ["stuck-idle", ["stuck 5 min"]], // minutes since it started waiting
  ["running", ["running implement"]],
  ["queued", ["queued triage"]],
  ["waiting", ["waits on 2"]],
  ["closed", ["closed: wont do"]],
];

describe("ui priority", () => {
  it("ranks every level in order with each tie-break, and the badge text for each", () => {
    const ranked = rank(seeds, NOW, LEASE);
    expect(ranked.map((r) => [r.input.name, r.badges])).toEqual(expected);
    // Every one of the eight levels is covered.
    expect(new Set(ranked.map((r) => r.level))).toEqual(new Set(LEVELS));
    expect([...new Set(ranked.map((r) => r.level))]).toEqual([...LEVELS]);
  });

  it("is independent of input order", () => {
    const reversed = rank([...seeds].reverse(), NOW, LEASE);
    expect(reversed.map((r) => r.input.name)).toEqual(expected.map(([n]) => n));
  });

  it("with no dependency data no item is waiting on another issue", () => {
    const noDeps = seeds.map((s) => ({ ...s, dependents: 0, waiting_on: 0 }));
    const ranked = rank(noDeps, NOW, LEASE);
    expect(ranked.some((r) => r.level === "waiting_on_issue")).toBe(false);
    expect(ranked.some((r) => r.badges.some((b) => b.startsWith("unblocks")))).toBe(false);
  });

  it("a running run within its lease is running, past it is stuck", () => {
    expect(levelOf(item("a", { run: running("implement", 0.5) }), NOW, LEASE)).toBe("running");
    expect(levelOf(item("b", { run: running("implement", 2) }), NOW, LEASE)).toBe("stuck");
  });

  it("a human block outranks an active run", () => {
    expect(levelOf(item("a", { blocked_on: "human", blocked_reason: "x", run: queued }), NOW, LEASE)).toBe("needs_human");
  });
});
