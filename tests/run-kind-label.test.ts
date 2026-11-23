// A run kind's plain label for owner text (issue #810): one map over every RunKind, in the dashboard's words.
import { describe, expect, it } from "vitest";
import { runKindLabel } from "../src/controller/units/run-results/run-kind-label.js";
import { repeatedFailureLines } from "../src/controller/units/run-results/retry.js";

describe("runKindLabel", () => {
  it("names each run kind in plain words", () => {
    expect(runKindLabel("merge-check")).toBe("Merge check");
    expect(runKindLabel("interactive")).toBe("Interactive task");
    expect(runKindLabel("triage")).toBe("Triage");
    expect(runKindLabel("implement")).toBe("Implement");
    expect(runKindLabel("review")).toBe("Review");
    expect(runKindLabel("manual")).toBe("Manual");
    expect(runKindLabel("routine")).toBe("Routine");
  });

  it("the repeated-failure comment names the run by its label, never its stored kind", () => {
    const body = repeatedFailureLines("merge-check", "tests_failed", "").join("\n");
    expect(body).toContain("The Merge check run failed twice in a row the same way:");
    expect(body).not.toContain("merge-check");
  });
});
