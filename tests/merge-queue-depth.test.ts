import { describe, expect, it } from "vitest";
import { MERGE_QUEUE_DEPTH_MAX, mergeQueueDepth } from "../src/compose.js";

// `merge_queue.depth` (RFC 0015 §7 Merge queue): absent is the solo default 1; a value outside 1..10 fails startup.

describe("merge_queue.depth", () => {
  it("is 1 when absent and the configured depth otherwise", () => {
    expect(mergeQueueDepth({})).toBe(1);
    expect(mergeQueueDepth({ merge_queue: {} })).toBe(1);
    expect(mergeQueueDepth({ merge_queue: { depth: 2 } })).toBe(2);
    expect(mergeQueueDepth({ merge_queue: { depth: MERGE_QUEUE_DEPTH_MAX } })).toBe(MERGE_QUEUE_DEPTH_MAX);
  });

  it("refuses a depth that is not an integer from 1 to the maximum", () => {
    for (const depth of [0, -1, 1.5, "2", MERGE_QUEUE_DEPTH_MAX + 1]) {
      expect(() => mergeQueueDepth({ merge_queue: { depth } }), String(depth)).toThrow(/merge_queue.depth must be an integer from 1 to 10/);
    }
  });
});
