import { describe, expect, it } from "vitest";
import { conflictParked, localMergeRefusal } from "../src/core/request-transition.js";
import type { WorkItem } from "../src/core/types.js";

// The local merge gate (design §5 Merge conflict, 2026-11-20): a local item parked on its merge conflict passes, so
// the controller probes its branch as it is; every other state keeps its refusal.

const item = (over: Partial<WorkItem>): WorkItem =>
  ({ id: "wi_1", source: { type: "local", id: "l-1", link: "local:l-1" }, stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null, ...over }) as unknown as WorkItem;
const name = (ref: string) => `PR #${ref}`;
const PARKED = { blocked_reason: "merge_conflict_pending" } as const;

describe("localMergeRefusal", () => {
  it("passes a local item parked at merge_conflict_pending, as one at merge_pending", () => {
    expect(conflictParked(item(PARKED))).toBe(true);
    expect(localMergeRefusal(item(PARKED), true, name)).toBeNull();
    expect(localMergeRefusal(item({}), true, name)).toBeNull();
    expect(localMergeRefusal(item(PARKED), false, name)).toBe("this controller has no sandbox that can merge locally");
  });

  it("keeps the PR refusal for a parked item with a PR, and the existing text for any other state", () => {
    expect(localMergeRefusal(item({ ...PARKED, change_ref: "7" }), true, name)).toBe("wi_1 has PR #7: merge the PR instead");
    expect(conflictParked(item({ stage: "READY", blocked_reason: "spec_pending" }))).toBe(false);
    expect(localMergeRefusal(item({ stage: "READY", blocked_reason: "spec_pending" }), true, name)).toBe(
      "wi_1 is not waiting for a merge (READY, spec_pending); `factory merge` applies once its review passed (merge_pending)",
    );
  });
});
