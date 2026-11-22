// Owner asks (design 06-efficiency, 07-improve-report): the reason code, the owner's action read from the next state
// change, the top reasons and the "approved unchanged N times in a row" proposal.

import { describe, expect, it } from "vitest";
import {
  ASK_PROPOSAL_RUN, ASK_REASON, ASK_TIER, ASK_TOP, type OwnerAsk, askDetail, ownerAction, ownerAsks, proposalText, reasonCode, standingProposals, topAskReasons,
} from "../src/core/owner-asks.js";
import type { StateChange, StateChangeDetail, StateChangeId, Timestamp, WorkItemId } from "../src/core/types.js";

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;

function change(item: string, version: number, at: number, reason: string, detail: StateChangeDetail | null = null, changes: StateChange["changes"] = {}): StateChange {
  return {
    id: `sc_${item}_${version}` as StateChangeId, work_item_id: item as WorkItemId, version, at: iso(at),
    actor: { kind: "system", id: "system:controller" }, reason, changes, detail,
  } as StateChange;
}

const ask = (reason: string, tier = 2) => ({ [ASK_REASON]: reason, [ASK_TIER]: tier });

/** One answered ask of `reason` at minute `i`, answered by `action`. */
function answered(reason: string, i: number, action: OwnerAsk["action"]): OwnerAsk {
  return { work_item_id: `wi_${i}` as WorkItemId, reason, tier: 1, at: iso(T0 + i * MIN), answered_at: iso(T0 + i * MIN + 1), action, wait_ms: 1 };
}

describe("owner asks: the reason code and the entry detail", () => {
  it("the reason code is the text before the first colon", () => {
    expect(reasonCode("run_failed:implement:checks_failed")).toBe("run_failed");
    expect(reasonCode("dependency_closed:wi_1")).toBe("dependency_closed");
    expect(reasonCode("dependency_cycle: a -> b")).toBe("dependency_cycle");
    expect(reasonCode("max_loops")).toBe("max_loops");
    expect(reasonCode(null)).toBe("unknown");
  });

  it("only a patch that blocks on the owner gets the reason code and tier", () => {
    expect(askDetail({ blocked_on: "human", blocked_reason: "run_failed:review:x" }, 3)).toEqual({ ask_reason: "run_failed", ask_tier: 3 });
    expect(askDetail({ blocked_on: "dependency", blocked_reason: "dependency_hold" }, 3)).toBeNull();
    expect(askDetail({ stage: "RUNNING" } as never, 3)).toBeNull();
  });
});

describe("owner asks: the owner's action from the next state change", () => {
  it("approved unchanged, changed, rejected or other", () => {
    expect(ownerAction(change("a", 2, T0, "spec_approved"))).toBe("approved_unchanged");
    expect(ownerAction(change("a", 2, T0, "spec_approved", null, { allowed_paths: { from: ["a"], to: ["a", "b"] } }))).toBe("changed");
    expect(ownerAction(change("a", 2, T0, "spec_approved", { spec_changed: true }))).toBe("changed");
    expect(ownerAction(change("a", 2, T0, "spec_revision_requested"))).toBe("changed");
    expect(ownerAction(change("a", 2, T0, "spec_rejected"))).toBe("rejected");
    expect(ownerAction(change("a", 2, T0, "retry_requested"))).toBe("other");
    expect(ownerAction(change("a", 2, T0, "toString"))).toBe("other");
  });

  it("each ask takes its item's next state change as its answer and wait; an unanswered ask has neither; rows without the detail are not asks", () => {
    const asks = ownerAsks([
      change("b", 3, T0 + 30 * MIN, "spec_rejected"),
      change("a", 1, T0, "intake"),
      change("a", 2, T0 + MIN, "spec_pending", ask("spec_pending", 1)),
      change("b", 2, T0 + 2 * MIN, "run_failed", ask("run_failed")),
      change("a", 3, T0 + 11 * MIN, "spec_approved"),
      change("c", 2, T0 + 3 * MIN, "max_loops", ask("max_loops")),
    ]);
    expect(asks.map((a) => [a.work_item_id, a.reason, a.tier, a.action, a.wait_ms])).toEqual([
      ["a", "spec_pending", 1, "approved_unchanged", 10 * MIN],
      ["b", "run_failed", 2, "rejected", 28 * MIN],
      ["c", "max_loops", 2, null, null],
    ]);
  });
});

describe("owner asks: the top reasons", () => {
  it(`ranks by asks, most first, then by code, keeps ${ASK_TOP}, and gives the share approved unchanged of the answered asks`, () => {
    const asks: OwnerAsk[] = [];
    let i = 0;
    const add = (reason: string, n: number, action: OwnerAsk["action"] = "approved_unchanged") => {
      for (let k = 0; k < n; k++) asks.push(answered(reason, ++i, action));
    };
    add("spec_pending", 3);
    add("spec_pending", 1, "changed");
    add("run_failed", 5, "other");
    add("max_loops", 2);
    add("dependency_closed", 2);
    add("merge_conflict", 1);
    add("budget", 1);
    asks.push({ ...answered("max_loops", ++i, null), answered_at: null });
    const top = topAskReasons(asks);
    expect(top).toHaveLength(ASK_TOP);
    expect(top.map((r) => [r.reason, r.asks])).toEqual([["run_failed", 5], ["spec_pending", 4], ["max_loops", 3], ["dependency_closed", 2], ["budget", 1]]);
    expect(top.find((r) => r.reason === "spec_pending")!.share_unchanged).toBe(0.75);
    expect(top.find((r) => r.reason === "run_failed")!.share_unchanged).toBe(0);
    expect(top.find((r) => r.reason === "max_loops")).toMatchObject({ asks: 3, answered: 2, share_unchanged: 1 });
    expect(topAskReasons([])).toEqual([]);
  });
});

describe("owner asks: the standing approval proposal", () => {
  const unchanged = (n: number, from = 0) => Array.from({ length: n }, (_, k) => answered("spec_pending", from + k, "approved_unchanged"));

  it(`${ASK_PROPOSAL_RUN - 1} approvals unchanged in a row give no proposal; ${ASK_PROPOSAL_RUN} give one`, () => {
    expect(standingProposals(unchanged(ASK_PROPOSAL_RUN - 1))).toEqual([]);
    expect(standingProposals(unchanged(ASK_PROPOSAL_RUN))).toEqual([{ reason: "spec_pending", run_length: ASK_PROPOSAL_RUN }]);
  });

  it("a changed or a rejected answer resets the run; an other answer neither counts nor resets", () => {
    for (const reset of ["changed", "rejected"] as const) {
      const asks = [...unchanged(5), answered("spec_pending", 5, reset), ...unchanged(ASK_PROPOSAL_RUN - 1, 6)];
      expect(standingProposals(asks)).toEqual([]);
      expect(standingProposals([...asks, answered("spec_pending", 99, "approved_unchanged")])).toEqual([{ reason: "spec_pending", run_length: ASK_PROPOSAL_RUN }]);
    }
    const other = [...unchanged(5), answered("spec_pending", 5, "other"), ...unchanged(5, 6)];
    expect(standingProposals(other)).toEqual([{ reason: "spec_pending", run_length: ASK_PROPOSAL_RUN }]);
  });

  it("counts each reason apart, and unanswered asks not at all; the proposal is text that names /standing", () => {
    const mixed = [...unchanged(ASK_PROPOSAL_RUN - 1), ...Array.from({ length: 3 }, (_, k) => answered("max_loops", 50 + k, "approved_unchanged"))];
    expect(standingProposals(mixed)).toEqual([]);
    expect(standingProposals([...unchanged(ASK_PROPOSAL_RUN - 1), { ...answered("spec_pending", 70, null), answered_at: null }])).toEqual([]);
    expect(proposalText({ reason: "spec_pending", run_length: 10 })).toContain("`/standing`");
  });
});
