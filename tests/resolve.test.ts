import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTO_RESOLVE_LIMIT, autoResolveAttempts, autoResolveKey, nextAutoResolveAttempt, parseAutoResolveKey, runKey, scopeViolations,
} from "../src/core/policy.js";
import { MERGE_CONFLICT_PENDING, conflictCounts, conflictCountsLine, resolveScopeViolations } from "../src/core/resolve.js";
import type { Run, StateChange } from "../src/core/types.js";

// Pure rules of automatic conflict resolution (design §5 Merge conflict, decided 2026-11-02).

const z = (...paths: string[]) => paths.map((p) => `${p}\0`).join("");

describe("scope rule for conflicting files", () => {
  const allowed = ["src/core/", "docs/design.md"];

  it("implement path: a conflicting file outside allowed_paths passes", () => {
    expect(scopeViolations(z("src/core/a.ts", "package.json"), allowed, ["package.json"])).toEqual([]);
  });

  it("implement path: an unrelated file outside allowed_paths still fails, conflicts or not", () => {
    expect(scopeViolations(z("src/core/a.ts", "package.json", "README.md"), allowed, ["package.json"])).toEqual(["README.md"]);
    expect(scopeViolations(z("README.md"), allowed)).toEqual(["README.md"]);
  });

  it("resolve path: a file that is neither conflicting nor allowed fails; conflicting and allowed ones pass", () => {
    expect(resolveScopeViolations(z("package.json", "src/core/x.ts", "SET_UP.md"), ["package.json"], allowed)).toEqual(["SET_UP.md"]);
    expect(resolveScopeViolations(z("package.json", "src/core/x.ts"), ["package.json"], allowed)).toEqual([]);
  });
});

describe("automatic resolve attempts", () => {
  it("keys are per item, base commit and attempt, and parse back", () => {
    const k = autoResolveKey("wi_1", "abc123", 2);
    expect(k).toBe("wi_1:resolve:auto:abc123:2");
    expect(parseAutoResolveKey(k)).toEqual({ work_item_id: "wi_1", base_sha: "abc123", attempt: 2 });
  });

  it("a human /resolve key, or any other key, is not automatic", () => {
    expect(parseAutoResolveKey(runKey({ id: "wi_1" as never, loop_count: 0, restart_count: 1 }, "resolve"))).toBeNull();
    expect(parseAutoResolveKey("wi_1:update:42:h:b")).toBeNull();
    expect(parseAutoResolveKey("wi_1:resolve:auto:abc:0")).toBeNull();
  });

  it("the limit is 2 per base commit", () => {
    expect(AUTO_RESOLVE_LIMIT).toBe(2);
    expect(nextAutoResolveAttempt(0)).toBe(1);
    expect(nextAutoResolveAttempt(1)).toBe(2);
    expect(nextAutoResolveAttempt(2)).toBeNull();
  });

  it("counts only the item's automatic runs for that base; a new base starts at 0", () => {
    const keys = [
      autoResolveKey("wi_1", "b1", 1), autoResolveKey("wi_1", "b1", 2), autoResolveKey("wi_1", "b1", 2),
      autoResolveKey("wi_1", "b2", 1), autoResolveKey("wi_2", "b1", 1), "wi_1:resolve:l0:r1",
    ];
    expect(autoResolveAttempts(keys, "wi_1", "b1")).toBe(2);
    expect(autoResolveAttempts(keys, "wi_1", "b2")).toBe(1);
    expect(autoResolveAttempts(keys, "wi_1", "b3")).toBe(0);
  });
});

describe("conflict counts", () => {
  const run = (kind: Run["kind"], key: string, data: Record<string, unknown> | null): Pick<Run, "kind" | "idempotency_key" | "outcome"> => ({
    kind,
    idempotency_key: key,
    outcome: data ? { status: "succeeded", summary: "", data } : { status: "failed", error_code: "x", detail: "", infra: false },
  });
  const change = (to: string | null): Pick<StateChange, "changes"> => ({ changes: { blocked_reason: { from: null, to } } });

  it("automatic: pushed automatic resolves with conflicts and pushed implement syncs with conflicts", () => {
    const runs = [
      run("resolve", autoResolveKey("wi_1", "b1", 1), { result: "pushed", conflicts: ["a"] }),
      run("resolve", autoResolveKey("wi_1", "b2", 1), { result: "pushed", conflicts: [] }), // clean merge: no conflict
      run("resolve", autoResolveKey("wi_1", "b3", 1), null), // failed
      run("resolve", "wi_1:resolve:l0:r1", { result: "pushed", conflicts: ["a"] }), // a person asked
      run("implement", "wi_1:implement:l0:r0", { pr_number: 42, conflicts: ["b"] }),
      run("implement", "wi_1:implement:l1:r0", { pr_number: 42 }), // no conflict
      run("implement", "wi_1:implement:l2:r0", { floor_block: true, conflicts: ["b"] }), // nothing pushed
    ];
    expect(conflictCounts(runs, [])).toEqual({ automatic: 2, person: 0 });
  });

  it("person: every change that set merge_conflict_pending", () => {
    const changes = [change(MERGE_CONFLICT_PENDING), change("merge_pending"), change(null), change(MERGE_CONFLICT_PENDING), { changes: {} }];
    expect(conflictCounts([], changes)).toEqual({ automatic: 0, person: 2 });
  });

  it("one sentence states both counts", () => {
    expect(conflictCountsLine({ automatic: 3, person: 1 })).toBe(
      "Merge conflicts on this item so far: 3 resolved automatically, 1 needed a person.",
    );
  });
});

describe("resolve prompt fixed rules", () => {
  const prompt = readFileSync("prompts/resolve.md", "utf8");

  it("keeps both sides' sections in docs/design.md and SET_UP.md", () => {
    expect(prompt).toContain("`docs/design.md`");
    expect(prompt).toContain("`SET_UP.md`");
    expect(prompt).toMatch(/keep both sides' sections/i);
  });

  it("renumbers a migration when both sides added one", () => {
    expect(prompt).toMatch(/both sides add(ed)? a migration/i);
    expect(prompt).toMatch(/renumber/i);
  });

  it("keeps both sides' entries in lists and tables", () => {
    expect(prompt).toMatch(/keep both sides' entries/i);
    expect(prompt).toMatch(/lists and tables/i);
  });
});
