import { describe, expect, it } from "vitest";
import type { SplitLimits } from "../src/core/split.js";
import type { WorkItem } from "../src/core/types.js";
import { PROJECT, config } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";

// The implement run's size readers (src/core/size-cap.ts): the prompt's diff budget, the gate hooks' limits and the
// pre-push size gate read the item's one-time cap when it has one, else the project settings.

const projectCaps = { settings: { ...config.settings, projects: { [PROJECT.key]: { max_diff_lines: 321, max_diff_files: 7 } } } };

/** A pipeline whose store returns every item with `cap` as its one-time cap (nothing writes one yet). */
async function withCap(cap: SplitLimits | null) {
  const f = await pipeline({ config: projectCaps });
  const get = f.store.getWorkItem.bind(f.store);
  f.store.getWorkItem = async (id) => {
    const it = await get(id);
    return it && cap ? ({ ...it, size_cap: cap } as WorkItem) : it;
  };
  return f;
}

describe("implement run: the item's size caps", () => {
  it("without a one-time cap: the project's caps in the prompt and the gate hooks", async () => {
    const f = await withCap(null);
    f.sandbox.numstat = `400\t0\t.github/workflows/scope.yml\0`; // over the project's 321 lines
    const item = await f.submit();
    await f.step();
    const spec = f.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.prompt).toContain("at most 321 lines");
    expect(spec.gate_hooks!.limits).toEqual({ max_diff_lines: 321, max_diff_files: 7 });
    expect((await f.runs(item, "implement")).map((r) => r.outcome)).toContainEqual(expect.objectContaining({ error_code: "diff_too_large" }));
  });

  it("with a one-time cap: that cap in the prompt, the gate hooks and the pre-push gate", async () => {
    const f = await withCap({ max_diff_lines: 900, max_diff_files: 30 });
    f.sandbox.numstat = `400\t0\t.github/workflows/scope.yml\0`; // over the project's 321 lines, under the item's 900
    const item = await f.submit();
    await f.step();
    const spec = f.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.prompt).toContain("at most 900 lines");
    expect(spec.prompt).toContain("at most 30 files");
    expect(spec.gate_hooks!.limits).toEqual({ max_diff_lines: 900, max_diff_files: 30 });
    const runs = await f.runs(item, "implement");
    expect(runs.every((r) => r.outcome?.status !== "failed" || r.outcome.error_code !== "diff_too_large")).toBe(true);
  });
});
