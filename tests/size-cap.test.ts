import { describe, expect, it } from "vitest";
import { sizeCaps } from "../src/core/size-cap.js";
import { atSizeCheckpoint, sizeCheckpointNote } from "../src/core/split.js";

const project = { max_diff_lines: 1500, max_diff_files: 40 };

describe("sizeCaps: an item's size caps through one function", () => {
  it("uses the project settings for an item without a one-time cap", () => {
    expect(sizeCaps({ project: "o/r" }, project)).toEqual(project);
    expect(sizeCaps({ project: "o/r", size_cap: null }, project)).toEqual(project);
  });

  it("uses the item's one-time cap when it has one", () => {
    expect(sizeCaps({ project: "o/r", size_cap: { max_diff_lines: 3000, max_diff_files: 60 } }, project)).toEqual({ max_diff_lines: 3000, max_diff_files: 60 });
  });

  it("returns only the two caps, never the rest of the settings", () => {
    expect(sizeCaps({ project: "o/r" }, { ...project, floors: [] } as typeof project)).toEqual(project);
  });
});

describe("size checkpoint of a triage answer", () => {
  it("is an estimate over 85% of either cap with no phases", () => {
    expect(atSizeCheckpoint({ estimated_lines: 1276, estimated_files: 1 }, project)).toBe(true);
    expect(atSizeCheckpoint({ estimated_lines: 10, estimated_files: 35 }, project)).toBe(true);
    expect(atSizeCheckpoint({ estimated_lines: 1275, estimated_files: 34 }, project)).toBe(false);
    expect(atSizeCheckpoint({ estimated_lines: 1400, estimated_files: 1, phases: [] }, project)).toBe(true);
    expect(atSizeCheckpoint({ estimated_lines: 1400, estimated_files: 1, phases: [1, 2] }, project)).toBe(false);
  });

  it("is read against the item's one-time cap when it has one", () => {
    const item = { project: "o/r", size_cap: { max_diff_lines: 3000, max_diff_files: 60 } };
    expect(atSizeCheckpoint({ estimated_lines: 1400, estimated_files: 20 }, sizeCaps(item, project))).toBe(false);
    expect(atSizeCheckpoint({ estimated_lines: 1400, estimated_files: 20 }, sizeCaps({ project: "o/r" }, project))).toBe(true);
  });

  it("its note names the estimate, the threshold and the replies", () => {
    const note = sizeCheckpointNote({ estimated_lines: 1400, estimated_files: 12 }, project);
    expect(note).toContain("1400 lines, 12 files");
    expect(note).toContain("1275 lines or 34 files");
    expect(note).toContain("`/approve`");
    expect(note).toContain("`/revise <feedback>`");
  });
});
