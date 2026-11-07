import { describe, expect, it } from "vitest";
import { type GateEvent, checkRuns, gateEvents, specChanged, specDecisionDetail, specKind } from "../src/core/standing.js";
import type { StateChange, StateChangeId, Tier, Timestamp, UserId, WorkItemId } from "../src/core/types.js";

const THRESHOLD = 10;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 1) + ++clock * 1000).toISOString();
const ev = (tier: Tier, outcome: GateEvent["outcome"], spec_changed = false): GateEvent => ({ gate: "spec", tier, outcome, spec_changed, at: at() });
const approvals = (tier: Tier, n: number) => Array.from({ length: n }, () => ev(tier, "approved"));
const run = (events: GateEvent[], tier: Tier) => checkRuns(events, THRESHOLD).find((r) => r.tier === tier);

describe("checkRuns: the run per (gate, tier)", () => {
  it("counts unchanged approvals in a row and reports when the threshold is reached", () => {
    expect(run(approvals(2, THRESHOLD - 1), 2)).toEqual({ gate: "spec", tier: 2, run_length: THRESHOLD - 1, reached: false });
    expect(run(approvals(2, THRESHOLD), 2)).toEqual({ gate: "spec", tier: 2, run_length: THRESHOLD, reached: true });
    expect(run(approvals(2, THRESHOLD + 3), 2)).toMatchObject({ run_length: THRESHOLD + 3, reached: true });
  });

  it("keeps each tier's run apart", () => {
    const events = [...approvals(1, 3), ...approvals(3, THRESHOLD), ev(1, "rejected"), ...approvals(1, 2)];
    const runs = checkRuns(events, THRESHOLD);
    expect(runs.find((r) => r.tier === 1)).toMatchObject({ run_length: 2, reached: false });
    expect(runs.find((r) => r.tier === 3)).toMatchObject({ run_length: THRESHOLD, reached: true });
    expect(runs.map((r) => r.tier)).toEqual([1, 3]);
  });

  it.each(["revised", "rejected", "retried"] as const)("a %s decision resets that (gate, tier) to 0, and only that one", (outcome) => {
    const events = [...approvals(2, 5), ...approvals(4, 4), ev(2, outcome)];
    expect(run(events, 2)).toMatchObject({ run_length: 0, reached: false });
    expect(run(events, 4)).toMatchObject({ run_length: 4 });
    expect(run([...events, ...approvals(2, 1)], 2)).toMatchObject({ run_length: 1 });
  });

  it("an approval that changed the spec resets the run", () => {
    expect(run([...approvals(2, 4), ev(2, "approved", true)], 2)).toMatchObject({ run_length: 0 });
  });

  it("takes events in time order, whatever the input order", () => {
    const events = [ev(2, "rejected"), ...approvals(2, 3)];
    expect(run([...events].reverse(), 2)).toMatchObject({ run_length: 3 });
    expect(run([...events, ev(2, "revised")].reverse(), 2)).toMatchObject({ run_length: 0 });
  });

  it("uses the threshold it is given", () => {
    expect(checkRuns(approvals(2, 3), 3)[0]).toMatchObject({ reached: true });
    expect(checkRuns(approvals(2, 3), 4)[0]).toMatchObject({ reached: false });
  });
});

describe("decision detail", () => {
  it("holds gate, tier, kind, outcome, spec_changed and the user's ID only", () => {
    const d = specDecisionDetail({ tier: 2, kind: "single", outcome: "approved", spec_changed: false, actor: { kind: "user", id: "github:1" as UserId } });
    expect(d).toEqual({ gate: "spec", tier: 2, kind: "single", outcome: "approved", spec_changed: false, owner_id: "github:1" });
  });

  it("kind: phase for an item with a parent, split for a spec with phases, else single", () => {
    expect(specKind({ parent_id: "wi_p" as WorkItemId }, false)).toBe("phase");
    expect(specKind({ parent_id: null }, true)).toBe("split");
    expect(specKind({ parent_id: null }, false)).toBe("single");
  });

  it("spec_changed: a revise always, an approval only with widened paths, a reject never", () => {
    expect(specChanged("revised", {})).toBe(true);
    expect(specChanged("approved", {})).toBe(false);
    expect(specChanged("approved", { allowed_paths: ["a"] })).toBe(true);
    expect(specChanged("rejected", { allowed_paths: ["a"] })).toBe(false);
  });
});

describe("gateEvents: one item's state changes", () => {
  let n = 0;
  const change = (reason: string, over: Partial<StateChange> = {}): StateChange => ({
    id: `sc${++n}` as StateChangeId,
    work_item_id: "wi_1" as WorkItemId,
    version: n,
    at: at() as Timestamp,
    actor: { kind: "user", id: "github:1" as UserId },
    reason,
    changes: {},
    detail: null,
    ...over,
  });

  it("reads the decision detail as written", () => {
    const detail = specDecisionDetail({ tier: 3, kind: "single", outcome: "approved", spec_changed: true, actor: { kind: "system", id: "x" } });
    expect(gateEvents([change("spec_approved", { detail })])).toMatchObject([{ gate: "spec", tier: 3, outcome: "approved", spec_changed: true }]);
  });

  it("backfills older rows from the reason and the item's tier; a retry counts at that tier; unknown tier is skipped", () => {
    const events = gateEvents([
      change("spec_approved"),
      change("triaged", { changes: { tier: { from: null, to: 2 } } }),
      change("spec_revision_requested"),
      change("spec_approved", { changes: { allowed_paths: { from: ["a"], to: ["a", "b"] }, tier: { from: 2, to: 3 } } }),
      change("retry_requested"),
      change("spec_rejected"),
      change("lease_expired"),
    ]);
    expect(events.map((e) => [e.tier, e.outcome, e.spec_changed])).toEqual([
      [2, "revised", true],
      [2, "approved", true],
      [3, "retried", false],
      [3, "rejected", false],
    ]);
  });
});
