import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_KINDS, autoApproveRefusal, autoMergeRefusal, effectiveTier, failureClass, floorTier, retryDelayMs, retryKey, runKey,
  sameStep, workItemIdFromBranch,
} from "../src/core/policy.js";
import { GATE_PATHS, gatePathTouched } from "../src/core/improver.js";
import { PROTECTED_PATHS, protectedCategory } from "../src/core/standing.js";
import { parseTriage } from "../src/core/outputs.js";
import { PROVIDER_SETUP } from "../src/interfaces/agent-runner.js";
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

  it("retry backoff is base × 2^(attempt−1), capped at max", () => {
    expect(retryDelayMs(1, 60_000, 1_800_000)).toBe(60_000);
    expect(retryDelayMs(2, 60_000, 1_800_000)).toBe(120_000);
    expect(retryDelayMs(5, 60_000, 1_800_000)).toBe(960_000);
    expect(retryDelayMs(6, 60_000, 1_800_000)).toBe(1_800_000);
    expect(retryDelayMs(10_000, 60_000, 1_800_000)).toBe(1_800_000);
  });

  it("retry keys are unique per retry and stay in the step of the run they retry", () => {
    const first = runKey({ id: "wi_1" as WorkItemId, loop_count: 2, restart_count: 0 }, "implement");
    const a1 = retryKey(first);
    const a2 = retryKey(a1);
    expect(a1).toBe(`${first}:a1`);
    expect(a2).toBe(`${first}:a2`);
    expect(retryKey(first)).toBe(a1); // deterministic: applying the same run twice asks for the same key
    expect(sameStep(first, a2)).toBe(true);
    expect(sameStep(first, runKey({ id: "wi_1" as WorkItemId, loop_count: 2, restart_count: 1 }, "implement"))).toBe(false);
  });

  it("classifies failures: rate limit, infra, task", () => {
    const failed = (error_code: string, infra: boolean) => ({ status: "failed" as const, error_code, detail: "", infra });
    expect(failureClass(failed("rate_limited", false))).toBe("rate_limited");
    expect(failureClass(failed("lease_lost", true))).toBe("infra");
    expect(failureClass(failed("agent_timed_out", true))).toBe("infra");
    expect(failureClass(failed("invalid_output", false))).toBe("task");
    expect(failureClass(failed("no_commits", false))).toBe("task");
    expect(failureClass(null)).toBe("task");
    // A provider's quota, key or model error is the task's own failure, never a rate limit (no claim pause).
    expect(failureClass(failed(PROVIDER_SETUP, false))).toBe("task");
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

describe("implement-type runs", () => {
  it("implement-type kinds are implement (also a review fix) and update; triage and review are not", () => {
    expect([...IMPLEMENT_KINDS].sort()).toEqual(["implement", "update"]);
  });
});

describe("auto mode rules (design 03-risk)", () => {
  const free = { default: "yes", owner_only: false };

  it("approves a spec below tier 4 whose decisions all have a default and none is owner-only", () => {
    expect(autoApproveRefusal({ tier: 3, decisions: [], gate_path: null })).toBeNull();
    expect(autoApproveRefusal({ tier: 1, decisions: [free, free], gate_path: null })).toBeNull();
  });

  it("leaves tier 4 and up, the gate list, an owner-only decision and one with no default for /approve", () => {
    expect(autoApproveRefusal({ tier: 4, decisions: [], gate_path: null })).toContain("tier 4");
    expect(autoApproveRefusal({ tier: 5, decisions: [], gate_path: null })).toContain("tier 5");
    expect(autoApproveRefusal({ tier: 2, decisions: [], gate_path: "prompts/" })).toContain("gate list");
    expect(autoApproveRefusal({ tier: 2, decisions: [free, { default: "yes", owner_only: true }], gate_path: null })).toContain("owner");
    expect(autoApproveRefusal({ tier: 2, decisions: [{ default: null, owner_only: false }], gate_path: null })).toContain("owner");
  });

  it("merges only a complete local change below tier 4, off the gate list, at or under the setting's tier", () => {
    const ok = { tier: 2 as const, max_tier: 3, incomplete: false, gate_path: null, local: true };
    expect(autoMergeRefusal(ok)).toBeNull();
    expect(autoMergeRefusal({ ...ok, local: false })).toContain("local");
    expect(autoMergeRefusal({ ...ok, tier: 4, max_tier: 9 })).toContain("tier 4");
    expect(autoMergeRefusal({ ...ok, gate_path: "src/core/policy.ts" })).toContain("gate list");
    expect(autoMergeRefusal({ ...ok, incomplete: true })).toContain("incomplete");
    expect(autoMergeRefusal({ ...ok, max_tier: 1 })).toContain("auto_merge_max_tier (1)");
    expect(autoMergeRefusal({ ...ok, max_tier: 0 })).toContain("auto_merge_max_tier (0)");
  });

  it("the gate list is one list: the merge check's paths, every standing-rule protected path, the grant and tool folders", () => {
    expect(GATE_PATHS).toEqual(expect.arrayContaining([...Object.values(PROTECTED_PATHS).flat(), "src/impl/grant/", "src/core/tools/"]));
    expect(new Set(GATE_PATHS).size).toBe(GATE_PATHS.length);
  });

  it("guard code is on the gate list and protected: identity, the G1 check and passport wrapper, outbound's scan, the default broker", () => {
    for (const file of [
      "src/identity/passport/restrictions.ts", // passport tokens and restrictions
      "src/compose.ts", // G1 toolchain check, PassportToolBroker around every broker
      "src/outbound/outbound.ts", // G5 scan and passport authorize before each delivery
      "src/impl/broker/passport-broker.ts",
      "src/impl/github/github-tool-broker.ts", // the default ToolBroker
      "src/impl/github/broker.plugin.ts",
    ]) {
      expect(gatePathTouched([file]), file).toBe(file);
      expect(protectedCategory([file], []), file).not.toBeNull();
    }
  });

  it("an allowed path or changed file touches the gate list when it is on it, under it, or a folder holding it", () => {
    expect(gatePathTouched(["docs/x.md", "src/core/policy.ts"])).toBe("src/core/policy.ts");
    expect(gatePathTouched(["src/impl/grant/static.ts"])).toBe("src/impl/grant/static.ts");
    expect(gatePathTouched(["src/core/tools/"])).toBe("src/core/tools/");
    expect(gatePathTouched(["src/"])).toBe("src/");
    expect(gatePathTouched(["./prompts/triage.md"])).toBe("./prompts/triage.md");
    expect(gatePathTouched(["docs/", "src/core/worker.ts", "tests/policy.test.ts"])).toBeNull();
  });

  it("a triage decision keeps its default and flag; a plain or unflagged one is owner-only, and a stored answer parses the same", () => {
    const r = parseTriage({
      ...triageSpec,
      decisions: [{ text: "Warn?", default: "No", owner_only: false }, { text: "Drop it?", default: "Yes" }, "Rename it?"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision_items).toEqual([
      { text: "Warn?", default: "No", owner_only: false },
      { text: "Drop it?", default: "Yes", owner_only: true },
      { text: "Rename it?", default: null, owner_only: true },
    ]);
    expect(r.value.decisions).toEqual(["Warn? Proposed default: No.", "Drop it? Proposed default: Yes. (owner only)", "Rename it?"]);
    const again = parseTriage(r.value);
    expect(again.ok && again.value.decision_items).toEqual(r.value.decision_items);
  });
});
