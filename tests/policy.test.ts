import { describe, expect, it } from "vitest";
import { effectiveTier, floorTier, runKey, workItemIdFromBranch } from "../src/core/policy.js";
import { parseTriage } from "../src/core/outputs.js";
import type { WorkItemId } from "../src/core/types.js";
import { triageSpec } from "./helpers/fakes.js";

describe("policy", () => {
  const floors = [{ prefix: "prompts/", tier: 3 as const }, { prefix: "src/impl/broker/", tier: 4 as const }];

  it("floor tier applies when a path is inside a floor or contains one", () => {
    expect(floorTier(["prompts/triage.md"], floors)).toBe(3);
    expect(floorTier(["src/"], floors)).toBe(4);
    expect(floorTier(["docs/"], floors)).toBeNull();
  });

  it("effective tier is the max and never below the previous", () => {
    expect(effectiveTier(1, 3, null)).toBe(3);
    expect(effectiveTier(2, null, 4)).toBe(4);
  });

  it("run keys differ per loop and restart", () => {
    const base = { id: "wi_1" as WorkItemId, loop_count: 0, restart_count: 0 };
    expect(runKey(base, "implement")).not.toBe(runKey({ ...base, loop_count: 1 }, "implement"));
    expect(runKey(base, "implement")).not.toBe(runKey({ ...base, restart_count: 1 }, "implement"));
  });

  it("maps factory branches back to work items", () => {
    expect(workItemIdFromBranch("factory/wi_1", "factory/")).toBe("wi_1");
    expect(workItemIdFromBranch("feature/x", "factory/")).toBeNull();
  });

  it("rejects unsafe allowed_paths from triage", () => {
    expect(parseTriage({ ...triageSpec, allowed_paths: ["../etc"] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, allowed_paths: ["/abs"] }).ok).toBe(false);
    expect(parseTriage(triageSpec).ok).toBe(true);
  });
});
