import { describe, expect, it } from "vitest";
import { parseTriage } from "../src/core/outputs.js";
import {
  MAX_PHASES, MIN_PHASES, PHASE_MARKER, SPLIT_PERCENT, needsSplit, parseSizeDetail, phaseIssueBody, phaseMarker,
  splitThresholds, suggestSplit,
} from "../src/core/split.js";
import { renderSpec } from "../src/core/spec-comment.js";
import { gates, issueRef, triageSpec } from "./helpers/fakes.js";

const limits = { max_diff_lines: gates().max_diff_lines, max_diff_files: gates().max_diff_files };
const phase = (n: number) => ({
  title: `Phase ${n}`,
  problem: `Problem of phase ${n}`,
  done_criteria: [`criterion ${n}`],
  allowed_paths: [`src/p${n}/`],
});

describe("split threshold", () => {
  it("is 85% of either configured cap, computed in one place", () => {
    expect(SPLIT_PERCENT).toBe(85);
    expect(splitThresholds(limits)).toEqual({ lines: 1275, files: 34 });
    expect(splitThresholds({ max_diff_lines: 1000, max_diff_files: 10 })).toEqual({ lines: 850, files: 8 });
  });

  it("splits only over the threshold of either cap", () => {
    expect(needsSplit({ estimated_lines: 1275, estimated_files: 34 }, limits)).toBe(false);
    expect(needsSplit({ estimated_lines: 1276, estimated_files: 1 }, limits)).toBe(true);
    expect(needsSplit({ estimated_lines: 10, estimated_files: 35 }, limits)).toBe(true);
  });
});

describe("triage output: estimates and phases", () => {
  it("requires estimated_lines and estimated_files as integers 0 or more", () => {
    expect(parseTriage(triageSpec).ok).toBe(true);
    const { estimated_lines: _l, ...noLines } = triageSpec;
    const { estimated_files: _f, ...noFiles } = triageSpec;
    expect(parseTriage(noLines).ok).toBe(false);
    expect(parseTriage(noFiles).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, estimated_lines: -1 }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, estimated_files: 1.5 }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, estimated_lines: "100" }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, estimated_lines: 0, estimated_files: 0 }).ok).toBe(true);
  });

  it("accepts well-formed phases and rejects malformed ones", () => {
    const ok = parseTriage({ ...triageSpec, phases: [phase(1), phase(2)] });
    expect(ok.ok && ok.value.phases?.map((p) => p.title)).toEqual(["Phase 1", "Phase 2"]);
    expect(parseTriage({ ...triageSpec, phases: [{ ...phase(1), done_criteria: [] }, phase(2)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: [{ ...phase(1), allowed_paths: [] }, phase(2)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: [{ ...phase(1), allowed_paths: ["../x"] }, phase(2)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: [{ ...phase(1), title: "" }, phase(2)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: [{ ...phase(1), problem: 3 }, phase(2)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: "x" }).ok).toBe(false);
    // One phase is no split; more than four is too many.
    expect(parseTriage({ ...triageSpec, phases: [phase(1)] }).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, phases: [1, 2, 3, 4, 5].map(phase) }).ok).toBe(false);
    // An empty list is the same as no phases.
    const empty = parseTriage({ ...triageSpec, phases: [] });
    expect(empty.ok && empty.value.phases).toBeUndefined();
  });

  it("over the threshold, with the caps given, needs 2 to 4 phases", () => {
    const big = { ...triageSpec, estimated_lines: 1400, estimated_files: 12 };
    expect(parseTriage(big).ok).toBe(true); // shape only, no caps
    const r = parseTriage(big, limits);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("1275");
    expect(parseTriage({ ...big, phases: [phase(1), phase(2)] }, limits).ok).toBe(true);
    expect(parseTriage({ ...big, phases: [1, 2, 3, 4].map(phase) }, limits).ok).toBe(true);
    expect(parseTriage({ ...triageSpec, estimated_files: 35 }, limits).ok).toBe(false);
    expect(parseTriage({ ...triageSpec, estimated_lines: 1275, estimated_files: 34 }, limits).ok).toBe(true);
    expect([MIN_PHASES, MAX_PHASES]).toEqual([2, 4]);
  });
});

describe("split spec comment", () => {
  it("an unsplit spec renders as before, with no split section", () => {
    const parsed = parseTriage(triageSpec);
    if (!parsed.ok) throw new Error(parsed.error);
    const text = renderSpec(parsed.value, 2);
    expect(text).not.toContain("Split into phases");
    expect(text).not.toContain("estimated");
  });

  it("lists the phases in order with title, problem, done criteria and allowed paths, then the footer", () => {
    const parsed = parseTriage({ ...triageSpec, estimated_lines: 1400, estimated_files: 20, phases: [phase(1), phase(2), phase(3)] }, limits);
    if (!parsed.ok) throw new Error(parsed.error);
    const text = renderSpec(parsed.value, 2, {}, "FOOTER");
    expect(text).toContain("### Split into phases");
    expect(text).toContain("about 1400 lines in 20 files");
    const at = (s: string) => text.indexOf(s);
    expect(at("#### Phase 1 of 3: Phase 1")).toBeGreaterThan(at("### Split into phases"));
    expect(at("#### Phase 2 of 3: Phase 2")).toBeGreaterThan(at("#### Phase 1 of 3"));
    expect(at("#### Phase 3 of 3: Phase 3")).toBeGreaterThan(at("#### Phase 2 of 3"));
    for (const n of [1, 2, 3]) {
      expect(text).toContain(`Problem of phase ${n}`);
      expect(text).toContain(`- criterion ${n}`);
      expect(text).toContain(`- \`src/p${n}/\``);
    }
    expect(text).toContain("one sub-issue per phase");
    expect(text.endsWith("FOOTER")).toBe(true);
  });
});

describe("phase issues", () => {
  it("the body names the parent and the phase it waits for, and the marker is unique per parent and phase", () => {
    const body = phaseIssueBody({ parent: issueRef(5), phase: phase(2), index: 2, total: 3, depends_on: issueRef(7) });
    expect(body).toContain("Phase 2 of 3");
    expect(body).toContain("o/r#5");
    expect(body).toContain("o/r#7");
    expect(body).toContain("- criterion 2");
    expect(body).toContain("- `src/p2/`");
    const first = phaseIssueBody({ parent: issueRef(5), phase: phase(1), index: 1, total: 3, depends_on: null });
    expect(first).toContain("starts at once");
    expect(phaseMarker("wi_a" as never, 1)).not.toBe(phaseMarker("wi_a" as never, 2));
    expect(PHASE_MARKER.test(phaseMarker("wi_a" as never, 2))).toBe(true);
    expect(PHASE_MARKER.test("an ordinary issue body")).toBe(false);
  });
});

describe("size checkpoint suggestion", () => {
  it("reads the counts from the size gate's detail", () => {
    expect(parseSizeDetail("the diff changes 2400 lines (limit max_diff_lines = 1500) in 30 files (limit max_diff_files = 40)"))
      .toEqual({ lines: 2400, files: 30 });
    expect(parseSizeDetail("something else")).toBeNull();
  });

  it("groups the paths into 2 to 4 ordered phases sized from the diff", () => {
    const paths = ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "tests/a.test.ts", "tests/b.test.ts", "docs/design.md"];
    const s = suggestSplit({ lines: 2400, files: 6, paths }, limits);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.length).toBeLessThanOrEqual(4);
    // Every path lands in exactly one phase, and each phase is well formed for a split spec.
    expect(s.flatMap((p) => p.allowed_paths).sort()).toEqual([...paths].sort());
    for (const p of s) {
      expect(p.title).not.toBe("");
      expect(p.done_criteria.length).toBeGreaterThan(0);
      expect(p.allowed_paths.length).toBeGreaterThan(0);
      expect(p.estimated_lines).toBeLessThanOrEqual(splitThresholds(limits).lines);
    }
    // Paths of one folder stay together.
    const of = (path: string) => s.findIndex((p) => p.allowed_paths.includes(path));
    expect(of("src/a/x.ts")).toBe(of("src/a/y.ts"));
  });

  it("uses more phases for a bigger diff, never more than four", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `d${i}/f.ts`);
    expect(suggestSplit({ lines: 2000, files: 40, paths }, limits)).toHaveLength(2);
    expect(suggestSplit({ lines: 3000, files: 40, paths }, limits)).toHaveLength(3);
    expect(suggestSplit({ lines: 90000, files: 40, paths }, limits)).toHaveLength(4);
  });

  it("suggests nothing when there is only one path to split", () => {
    expect(suggestSplit({ lines: 5000, files: 1, paths: ["big.ts"] }, limits)).toEqual([]);
  });
});
