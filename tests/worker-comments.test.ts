import { describe, expect, it } from "vitest";
import { pipeline, runComments } from "./helpers/fakes.js";

// RFC 0015 M7, worker half: a run's comment is a thread entry that outbound delivers, never a write of the run's
// own. A step that runs again after a restart records the same entry, so the comment leaves once.

describe("a run's comments go out through outbound", () => {
  it("a comment recorded twice under one marker (its step re-run after a restart) is stored and delivered once", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    const marker = "<!-- factory:review:run_restarted -->";
    await f.w1.comment(it0, { pr: null, body: "the review", marker });
    await f.w1.comment(it0, { pr: null, body: "the review", marker });
    expect((await runComments(f.store, it0.id)).filter((c) => c.marker === marker)).toHaveLength(1);
    await f.controller.tickOutbox();
    expect(f.source.comments.filter((c) => c.body.includes("the review"))).toHaveLength(1);
    expect(f.broker.calls).toEqual([]);
  });

  it("a PR comment goes to the PR through the forge, not to the item's issue", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    await f.w1.comment(it0, { pr: 42, body: "on the PR", marker: "<!-- factory:update:run_1 -->" });
    await f.controller.tickOutbox();
    expect(f.forge.comments.map((c) => [c.pr_number, c.body])).toEqual([[42, "on the PR"]]);
    expect(f.source.comments.some((c) => c.body === "on the PR")).toBe(false);
  });
});
