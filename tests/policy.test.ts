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

  it("accepts files_to_change that allowed_paths covers exactly or by a directory prefix", () => {
    const spec = { ...triageSpec, allowed_paths: ["src/core/outputs.ts", "tests/"] };
    expect(parseTriage({ ...spec, files_to_change: ["src/core/outputs.ts", "tests/"] }).ok).toBe(true);
    expect(parseTriage({ ...spec, files_to_change: ["tests/policy.test.ts"] }).ok).toBe(true);
  });

  it("rejects files_to_change that allowed_paths does not cover, naming each path", () => {
    const spec = { ...triageSpec, allowed_paths: ["src/core/outputs.ts", "tests/"] };
    const r = parseTriage({ ...spec, files_to_change: ["src/core/outputs.ts", "docs/design.md", "src/core/controller.ts"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("docs/design.md");
    expect(r.error).toContain("src/core/controller.ts");
    expect(r.error).not.toContain("src/core/outputs.ts");
    // A prefix without a trailing slash covers only itself.
    const noSlash = parseTriage({ ...triageSpec, allowed_paths: ["src/core"], files_to_change: ["src/core/outputs.ts"] });
    expect(noSlash.ok).toBe(false);
    // Plain string prefix of a sibling directory does not count.
    const sibling = parseTriage({ ...triageSpec, allowed_paths: ["tests/"], files_to_change: ["tests2/x.ts"] });
    expect(sibling.ok).toBe(false);
  });

  it("rejects missing or non-array files_to_change", () => {
    const { files_to_change: _omit, ...without } = triageSpec;
    expect(parseTriage(without).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, files_to_change: "tests/" }).ok).toBe(false);
  });

  it("rejects an empty files_to_change entry", () => {
    expect(parseTriage({ ...triageSpec, allowed_paths: ["tests/"], files_to_change: [""] }).ok).toBe(false);
  });

  it("rejects an absolute files_to_change entry", () => {
    expect(parseTriage({ ...triageSpec, allowed_paths: ["tests/"], files_to_change: ["/tests/a.ts"] }).ok).toBe(false);
  });

  it("rejects a files_to_change entry with a .. segment", () => {
    expect(parseTriage({ ...triageSpec, allowed_paths: ["tests/"], files_to_change: ["tests/../src/x.ts"] }).ok).toBe(false);
  });
});
