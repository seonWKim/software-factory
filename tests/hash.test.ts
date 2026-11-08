// The cyrb53 hash builds stored keys (alarm `repeated_error` pattern keys, the improver's filed-pattern keys), so its
// output must never change. The expected values were taken from the copy in src/core/alarms.ts before it moved.

import { describe, expect, it } from "vitest";
import { cyrb53 } from "../src/core/hash.js";
import { patternKey } from "../src/core/improver.js";

describe("cyrb53", () => {
  it("keeps its pinned 14-character hex output", () => {
    expect(cyrb53("")).toBe("0bdcb81aee8d83");
    expect(cyrb53("hello world")).toBe("0b9417d15d1014");
    expect(cyrb53("agent_failed\nboom")).toBe("04d6866ebb64f1");
  });

  it("is what the improver's pattern key hashes: code and detail on two lines", () => {
    expect(patternKey({ error_code: "agent_failed", detail: "boom" })).toBe("04d6866ebb64f1");
  });
});
