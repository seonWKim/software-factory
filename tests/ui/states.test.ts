import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GROUP_LABELS, ITEM_STATES, STATE_GROUPS, STATE_KEYS, STATES, filterShowsFinished, groupStates, inStateFilter, stateLabel, stateTone,
} from "../../src/shared/states.js";

// The one state table (src/shared/states.ts): the given values of the work item, row by row.
const GIVEN: [string, string, string, string, number, string][] = [
  ["ready_to_merge", "Ready to merge", "needs", "ok", 1, "Merge"],
  ["needs_approval", "Needs approval", "needs", "warn", 2, "Approve"],
  ["needs_you", "Needs you", "needs", "bad", 3, "Answer"],
  ["needs_triage", "Needs triage", "waiting", "warn", 4, "Answer"],
  ["failed", "Failed", "problem", "bad", 5, "Review"],
  ["stuck", "Stuck", "problem", "bad", 6, "Review"],
  ["running", "Running", "active", "info", 7, "Open"],
  ["queued", "Queued", "active", "neutral", 8, "Open"],
  ["draining", "Draining", "active", "info", 9, "Open"],
  ["held", "Held", "waiting", "neutral", 10, "Open"],
  ["blocked_by_task", "Blocked by another task", "waiting", "neutral", 11, "Open"],
  ["merged", "Merged", "finished", "ok", 12, "Open"],
  ["closed", "Closed", "finished", "neutral", 13, "Open"],
  ["rejected", "Rejected", "finished", "neutral", 14, "Open"],
  ["succeeded", "Succeeded", "finished", "ok", 15, "Open"],
  ["cancelled", "Cancelled", "finished", "neutral", 16, "Open"],
];

describe("the state table", () => {
  it.each(GIVEN)("%s is %s, in %s, %s, sort %d, action %s", (key, label, group, tone, sort, action) => {
    expect(STATES[key as keyof typeof STATES]).toEqual({ label, group, tone, sort, action });
  });

  it("is pure: the module imports nothing", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "shared", "states.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("lists the keys in sort order", () => {
    const sorts = STATE_KEYS.map((k) => STATES[k].sort);
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
    expect(STATE_KEYS.indexOf("ready_to_merge")).toBeLessThan(STATE_KEYS.indexOf("stuck"));
    expect(STATE_KEYS.indexOf("stuck")).toBeLessThan(STATE_KEYS.indexOf("running"));
  });

  it("has five groups, in tab order, with their labels", () => {
    expect(STATE_GROUPS).toEqual(["needs", "active", "waiting", "problem", "finished"]);
    expect(GROUP_LABELS).toEqual({ needs: "Needs you", active: "Active", waiting: "Waiting", problem: "Problem", finished: "Finished" });
  });

  it("puts each state in its group; draining, succeeded and cancelled are no item state", () => {
    expect(groupStates("needs")).toEqual(["ready_to_merge", "needs_approval", "needs_you"]);
    expect(groupStates("active")).toEqual(["running", "queued"]);
    expect(groupStates("waiting")).toEqual(["needs_triage", "held", "blocked_by_task"]);
    expect(groupStates("problem")).toEqual(["failed", "stuck"]);
    expect(groupStates("finished")).toEqual(["merged", "closed", "rejected"]);
    for (const k of ["draining", "succeeded", "cancelled"]) expect(ITEM_STATES).not.toContain(k);
    expect(STATES.draining.group).toBe("active");
    expect(STATES.succeeded.group).toBe("finished");
  });

  it("reads an unknown key as words and neutral", () => {
    expect(stateLabel("needs_you")).toBe("Needs you");
    expect(stateLabel("some_state")).toBe("some state");
    expect(stateTone("running")).toBe("info");
    expect(stateTone("nope")).toBe("neutral");
    expect(stateTone(undefined)).toBe("neutral");
  });

  it("matches a group, one state, and closed as every Finished state", () => {
    expect(inStateFilter("needs_approval", "needs")).toBe(true);
    expect(inStateFilter("needs_triage", "needs")).toBe(false);
    expect(inStateFilter("failed", "problem")).toBe(true);
    expect(inStateFilter("held", "held")).toBe(true);
    expect(inStateFilter("held", "blocked_by_task")).toBe(false);
    for (const s of ["merged", "closed", "rejected"]) expect(inStateFilter(s, "closed")).toBe(true);
    expect(inStateFilter("running", "closed")).toBe(false);
    for (const f of ["finished", "closed", "merged", "rejected"]) expect(filterShowsFinished(f)).toBe(true);
    for (const f of [null, "needs", "running"]) expect(filterShowsFinished(f)).toBe(false);
  });
});
