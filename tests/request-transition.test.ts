import { describe, expect, it } from "vitest";
import { MERGE_CHECK_AGAIN, conflictParked, localMergeRefusal, mergeCheckAgain, mergeCheckStopped } from "../src/core/request-transition.js";
import type { StateChange, WorkItem } from "../src/core/types.js";

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

describe("the merge gate at max_loops (design 04-spec-gate-commands, 2026-11-23)", () => {
  const STOPPED = { blocked_reason: "max_loops", loop_count: 2 } as const;
  const change = (reason: string, detail: Record<string, string> = {}) => ({ reason, detail }) as unknown as StateChange;
  const fromCheck = [change("merge_check_queued", { entry_id: "mqe_1" }), change("max_loops", { entry_id: "mqe_1" })];
  const fromLoops = [change("max_loops", { entry_id: "mqe_1" }), change("retry_requested"), change("max_loops", { comment_id: "c1" })];
  const owner = { kind: "user", id: "local:me" } as StateChange["actor"];

  it("passes only an item whose latest max_loops change came from a merge check", () => {
    expect(mergeCheckStopped(item(STOPPED), fromCheck)).toBe(true);
    expect(mergeCheckStopped(item(STOPPED), fromLoops)).toBe(false);
    expect(mergeCheckStopped(item({ ...STOPPED, change_ref: "7" }), fromCheck)).toBe(false);
    expect(mergeCheckStopped(item({}), fromCheck)).toBe(false);
    expect(localMergeRefusal(item(STOPPED), true, name, mergeCheckStopped(item(STOPPED), fromCheck))).toBeNull();
    expect(localMergeRefusal(item(STOPPED), true, name, mergeCheckStopped(item(STOPPED), fromLoops))).toBe(
      "wi_1 is not waiting for a merge (REVIEW, max_loops); `factory merge` applies once its review passed (merge_pending)",
    );
  });

  it("the owner's merge goes back to merge_pending under its own reason with the owner as actor; elsewhere it is null", () => {
    expect(mergeCheckAgain(item(STOPPED), fromCheck, owner)).toEqual({
      patch: { blocked_on: "human", blocked_reason: "merge_pending" }, actor: owner, reason: MERGE_CHECK_AGAIN, detail: { loop_count: 2 },
    });
    expect(mergeCheckAgain(item(STOPPED), fromLoops, owner)).toBeNull();
    expect(mergeCheckAgain(item({}), fromCheck, owner)).toBeNull();
  });
});
