import { describe, expect, it } from "vitest";
import { LEVEL_LABELS, LEVELS, NEEDS_YOU, type PriorityInput, levelOf, rank } from "../../src/ui/priority.js";

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
  item("triage-ask", { stage: "NEW", blocked_on: "human", blocked_reason: "agent_needs_human", asked_by: "triage", since: at(15) }),
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
  ["triage-ask", ["triage asks"]],
  ["stuck-lease", ["stuck 12 min"]], // minutes since the last heartbeat
  ["stuck-idle", ["stuck 5 min"]], // minutes since it started waiting
  ["running", ["running implement"]],
  ["queued", ["queued triage"]],
  ["waiting", ["waits on 2 issues"]],
  ["closed", ["closed: wont do"]],
];

describe("ui priority", () => {
  it("ranks every level in order with each tie-break, and the badge text for each", () => {
    const ranked = rank(seeds, NOW, LEASE);
    expect(ranked.map((r) => [r.input.name, r.badges])).toEqual(expected);
    // Every level is covered, in order.
    expect(new Set(ranked.map((r) => r.level))).toEqual(new Set(LEVELS));
    expect([...new Set(ranked.map((r) => r.level))]).toEqual([...LEVELS]);
  });

  it("is independent of input order", () => {
    const reversed = rank([...seeds].reverse(), NOW, LEASE);
    expect(reversed.map((r) => r.input.name)).toEqual(expected.map(([n]) => n));
  });

  it("with no dependency data no item is blocked by another task", () => {
    const noDeps = seeds.map((s) => ({ ...s, dependents: 0, waiting_on: 0 }));
    const ranked = rank(noDeps, NOW, LEASE);
    expect(ranked.some((r) => r.level === "blocked_by_task")).toBe(false);
    expect(ranked.some((r) => r.badges.some((b) => b.startsWith("unblocks")))).toBe(false);
  });

  it("a running run within its lease is running, past it is stuck", () => {
    expect(levelOf(item("a", { run: running("implement", 0.5) }), NOW, LEASE)).toBe("running");
    expect(levelOf(item("b", { run: running("implement", 2) }), NOW, LEASE)).toBe("stuck");
  });

  it("an item blocked on another item (upstream, dependency) is blocked, never stuck, and names the issue when it is one", () => {
    const held = item("held", { stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold", waiting_on: 1, waiting_on_number: 191, since: at(76) });
    const parent = item("parent", { stage: "READY", blocked_on: "upstream", blocked_reason: "phases_open", waiting_on: 4, since: at(76) });
    const unknown = item("unknown", { stage: "NEW", blocked_on: "dependency", since: at(76) });
    const ranked = rank([held, parent, unknown], NOW, LEASE);
    expect(ranked.map((r) => r.level)).toEqual(["blocked_by_task", "blocked_by_task", "blocked_by_task"]);
    expect(Object.fromEntries(ranked.map((r) => [r.input.name, r.badges[0]]))).toEqual({
      held: "waits on #191",
      parent: "waits on 4 issues",
      unknown: "waits on another issue",
    });
  });

  it("a coordination hold (a queued run held by an unapproved claim) is blocked by another task and names the holder", () => {
    const h = item("h", { run: { ...queued, kind: "implement" }, held: true, waiting_on_number: 41 });
    expect(levelOf(h, NOW, LEASE)).toBe("blocked_by_task");
    expect(rank([h], NOW, LEASE)[0]!.badges).toEqual(["waits on #41"]);
    expect(rank([{ ...h, waiting_on_number: null }], NOW, LEASE)[0]!.badges).toEqual(["held by another task"]);
  });

  it("a dependency hold is blocked by another task even while its run is queued", () => {
    const dep = item("dep", { blocked_on: "dependency", blocked_reason: "waiting for #12 to merge", run: queued, waiting_on: 1, waiting_on_number: 12 });
    expect(levelOf(dep, NOW, LEASE)).toBe("blocked_by_task");
    expect(rank([dep], NOW, LEASE)[0]!.badges).toEqual(["waits on #12"]);
  });

  it("a deadlock claim on the item's run is blocked by another task and names the item it waits on", () => {
    const d = item("d", { run: running("implement", 0), deadlock: true, waiting_on_number: 7 });
    expect(levelOf(d, NOW, LEASE)).toBe("blocked_by_task");
    expect(rank([d], NOW, LEASE)[0]!.badges).toEqual(["deadlock with #7"]);
  });

  it("a triage run's ask needs triage", () => {
    const t = item("t", { stage: "NEW", blocked_on: "human", blocked_reason: "agent_needs_human", asked_by: "triage" });
    expect(levelOf(t, NOW, LEASE)).toBe("needs_triage");
    expect(rank([t], NOW, LEASE)[0]!.badges).toEqual(["triage asks"]);
  });

  it("an agent ask with no dependency (implement, review, resolve) needs you", () => {
    for (const kind of ["implement", "review", "resolve"] as const) {
      expect(levelOf(item(kind, { blocked_on: "human", blocked_reason: "agent_needs_human", asked_by: kind }), NOW, LEASE)).toBe("needs_you");
    }
  });

  it("merge pending is in the Needs you group, never blocked by another task", () => {
    const m = item("m", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", held: true, waiting_on_number: 3 });
    expect(levelOf(m, NOW, LEASE)).toBe("ready_to_merge");
    expect(NEEDS_YOU).toContain("ready_to_merge");
  });

  it("every human block reason and the budget need you, with a fixed-word badge; a null reason too", () => {
    const reasons = [
      ["spec_pending", "needs approval"],
      ["run_failed:implement:timeout", "failed"],
      ["max_loops", "too many loops"],
      ["merge_conflict_pending", "merge conflict"],
      ["rule_of_two", "needs you"],
      ["dependency_closed:#92", "needs you"],
      ["something_new", "needs you"],
      [null, "needs you"],
    ] as const;
    for (const [reason, badge] of reasons) {
      const h = item(String(reason), { blocked_on: "human", blocked_reason: reason, deadlock: true, held: true });
      const [r] = rank([h], NOW, LEASE);
      expect(NEEDS_YOU).toContain(r!.level);
      expect(r!.level).not.toBe("blocked_by_task");
      expect(r!.badges[0]).toBe(badge);
    }
    const b = rank([item("budget", { blocked_on: "budget", blocked_reason: null })], NOW, LEASE)[0]!;
    expect([b.level, b.badges[0]]).toEqual(["needs_you", "budget check"]);
  });

  it("a human block outranks an active run", () => {
    expect(levelOf(item("a", { blocked_on: "human", blocked_reason: "x", run: queued }), NOW, LEASE)).toBe("needs_you");
  });

  it("the old level ids needs_human and waiting_on_issue are gone", () => {
    for (const old of ["needs_human", "waiting_on_issue"]) {
      expect(LEVELS as readonly string[]).not.toContain(old);
      expect(Object.keys(LEVEL_LABELS)).not.toContain(old);
    }
    expect(LEVEL_LABELS).toMatchObject({ needs_you: "Needs you", needs_triage: "Needs triage", blocked_by_task: "Blocked by another task" });
    expect(NEEDS_YOU).not.toContain("blocked_by_task");
  });
});
