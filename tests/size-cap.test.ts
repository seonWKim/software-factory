import { describe, expect, it } from "vitest";
import { OVER_CAP_NO_SIZE, SIZE_CAP_APPROVED, overCapApproval, overCapNoteRequired, sizeCaps, storedProjectCaps, storedSizeCapApproval } from "../src/core/size-cap.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { TOO_LARGE, atSizeCheckpoint, overCap, proposedCap, sizeCheckpointNote, suggestedSplit } from "../src/core/split.js";
import { sizeDetail } from "../src/core/diff-gate.js";
import type { Run } from "../src/core/types.js";

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

  it("its note names `/approve <why>` with the size, the caps and the proposed one-time cap", () => {
    const note = sizeCheckpointNote({ estimated_lines: 1400, estimated_files: 12 }, project);
    expect(note).toContain("`/approve <why>`");
    expect(note).toContain("1400 lines in 12 files against `max_diff_lines` = 1500 and `max_diff_files` = 40");
    expect(note).toContain("one-time cap of 1648 lines and 40 files");
  });
});

// An over-cap `/approve` (design 04-split-specs, 2026-11-24).
describe("proposedCap", () => {
  it("raises each cap just enough that the size is no longer at its size checkpoint, never below the cap in force", () => {
    expect(proposedCap({ lines: 1400, files: 12 }, project)).toEqual({ max_diff_lines: 1648, max_diff_files: 40 });
    expect(proposedCap({ lines: 5000, files: 60 }, project)).toEqual({ max_diff_lines: 5883, max_diff_files: 71 });
    for (const sizes of [{ lines: 1400, files: 12 }, { lines: 5000, files: 60 }, { lines: 10, files: 35 }]) {
      const cap = proposedCap(sizes, project);
      expect(atSizeCheckpoint({ estimated_lines: sizes.lines, estimated_files: sizes.files }, cap), JSON.stringify(sizes)).toBe(false);
    }
  });
});

describe("overCap: whether an /approve is over the item's caps", () => {
  const gate = { project: "o/r", stage: "READY" as const, blocked_reason: "spec_pending" };
  const big = { estimated_lines: 1400, estimated_files: 12 };
  const failed = (detail: string, error_code = "diff_too_large") =>
    ({ kind: "implement", outcome: { status: "failed", error_code, detail, infra: false } }) as unknown as Run;
  const tooLarge = { project: "o/r", stage: "RUNNING" as const, blocked_reason: TOO_LARGE };

  it("at the spec gate, a spec at its size checkpoint: its estimate", () => {
    expect(overCap(gate, [], big, project)).toEqual({
      at: "spec", sizes: { lines: 1400, files: 12 }, caps: project, project_cap: project, one_time_cap: { max_diff_lines: 1648, max_diff_files: 40 },
    });
    expect(overCap({ ...gate, blocked_reason: "max_revisions" }, [], big, project)).toMatchObject({ at: "spec" });
  });

  it("not over: a spec under the threshold, one with phases, no spec, or an item not at the gate", () => {
    expect(overCap(gate, [], { estimated_lines: 1275, estimated_files: 34 }, project)).toBeNull();
    expect(overCap(gate, [], { ...big, phases: [1, 2] }, project)).toBeNull();
    expect(overCap(gate, [], null, project)).toBeNull();
    expect(overCap({ ...gate, stage: "RUNNING", blocked_reason: "floor_tier" }, [], big, project)).toBeNull();
  });

  it("the caps in force are the item's: under its one-time cap the spec is not over", () => {
    expect(overCap({ ...gate, size_cap: { max_diff_lines: 3000, max_diff_files: 60 } }, [], big, project)).toBeNull();
  });

  it("at too_large: the newest diff_too_large run's diff size; none recorded is { sizes: null }", () => {
    const runs = [failed(sizeDetail({ lines: 2000, files: 30 }, project)), failed("other", "no_commits"), failed(sizeDetail({ lines: 5000, files: 60 }, project))];
    expect(overCap(tooLarge, runs, null, project)).toEqual({
      at: "too_large", sizes: { lines: 5000, files: 60 }, caps: project, project_cap: project, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 },
    });
    expect(overCap(tooLarge, [failed("the diff is too large")], null, project)).toEqual({ sizes: null });
    expect(overCap(tooLarge, [], null, project)).toEqual({ sizes: null });
  });
});

describe("overCapApproval", () => {
  const over = overCap({ project: "o/r", stage: "READY", blocked_reason: "spec_pending" }, [], { estimated_lines: 1400, estimated_files: 12 }, project)!;
  const actor = { kind: "user" as const, id: "local:me" as never };
  const approved = { patch: { stage: "RUNNING" as const }, detail: { note: "why" } };

  it("refuses with no note, or a blank one, with the size, the caps and the proposed cap", () => {
    for (const note of [null, "", "  \n "]) expect(overCapApproval(over, actor, note, approved)).toEqual({ refuse: overCapNoteRequired(over as never) });
    const text = overCapNoteRequired(over as never);
    expect(text).toContain("1400 lines in 12 files is over the cap (`max_diff_lines` = 1500, `max_diff_files` = 40)");
    expect(text).toContain("reply `/approve <why>` to approve a one-time cap of 1648 lines and 40 files, so nothing was stored");
  });

  it("refuses at too_large when the blocked run recorded no size, note or not", () => {
    expect(overCapApproval({ sizes: null }, actor, "why", approved)).toEqual({ refuse: OVER_CAP_NO_SIZE });
  });

  it("with a note: the approval's own transition gets the one-time cap and the size_cap_approved record", () => {
    const d = overCapApproval(over, actor, " why ", approved);
    expect(d).toMatchObject({ patch: { stage: "RUNNING", size_cap: { max_diff_lines: 1648, max_diff_files: 40 } }, detail: { note: "why" } });
    const detail = (d as { detail: Record<string, unknown> }).detail;
    expect(storedSizeCapApproval(detail)).toEqual({
      actor: "local:me", sizes: { lines: 1400, files: 12 }, project_cap: project, one_time_cap: { max_diff_lines: 1648, max_diff_files: 40 }, note: "why",
    });
    expect(typeof detail[SIZE_CAP_APPROVED]).toBe("string");
  });

  it("not over the caps, or no transition to add to: as it is", () => {
    expect(overCapApproval(null, actor, null, approved)).toBe(approved);
    expect(overCapApproval(over, actor, "why", { refuse: "no" })).toEqual({ refuse: "no" });
    expect(overCapApproval(over, actor, "why", null)).toBeNull();
    expect(storedSizeCapApproval({ note: "x" })).toBeNull();
    expect(storedSizeCapApproval(null)).toBeNull();
  });
});

describe("the too_large comment's size section", () => {
  it("names `/approve <why>` with the diff size, the caps and the proposed cap, before the suggested split", () => {
    const lines = suggestedSplit(sizeDetail({ lines: 5000, files: 60 }, project), ["src/a/", "src/b/"], project);
    expect(lines[0]).toContain("`/approve <why>` to run the implementer again on the same spec over the cap");
    expect(lines[0]).toContain("5000 lines in 60 files against `max_diff_lines` = 1500 and `max_diff_files` = 40");
    expect(lines[0]).toContain("one-time cap of 5883 lines and 71 files");
    expect(lines.indexOf("### Suggested split")).toBeGreaterThan(0);
    expect(suggestedSplit("no counts here", ["src/a/"], project)).toEqual([]);
  });
});

describe("storedProjectCaps: the caps the CLI and the dashboard check an /approve against", () => {
  const base = { file: {}, layers: { defaults: { max_diff_lines: 1500, max_diff_files: 40 }, projects: { "o/r": { max_diff_files: 30 } } } };

  it("reads the file's layers (the owner/name block as the project's key), then the stored overrides and the learned layer, as the controller does", async () => {
    const { store } = await newStore();
    expect(await storedProjectCaps(store, base, "o/r", PROJECT_KEY, PROJECT_KEY)).toEqual({ max_diff_lines: 1500, max_diff_files: 30 });
    expect(await storedProjectCaps(store, base, "o/r", null, PROJECT_KEY)).toEqual({ max_diff_lines: 1500, max_diff_files: 40 });
    await store.setSettingOverride({ key: "max_diff_lines", project: PROJECT_KEY, value: "1200", actor: "local:test" });
    expect(await storedProjectCaps(store, base, "o/r", PROJECT_KEY, PROJECT_KEY)).toEqual({ max_diff_lines: 1200, max_diff_files: 30 });
    await store.setLearnedSetting({ project: PROJECT_KEY, key: "max_diff_lines", expected: null, value: "1000", evidence_run_ids: [], window_end: "2026-11-24T00:00:00.000Z" as never, actor: "improver" });
    expect(await storedProjectCaps(store, base, "o/r", PROJECT_KEY, PROJECT_KEY)).toEqual({ max_diff_lines: 1000, max_diff_files: 30 });
  });
});
