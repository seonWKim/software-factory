import { describe, expect, it } from "vitest";
import { parseTriage } from "../src/core/outputs.js";
import { triageSpec } from "./helpers/fakes/config.js";

// Triage refuses `.claude/` paths (design 04-triage.md, 2026-11-15): they are owner-only, and the agent sandbox
// refuses every write there, so a spec naming one would stop its implement run and wait on a person.

const FILE = ".claude/agents/gongbang-designer.md";
const phase = (n: number, allowed: string[]) => ({
  title: `Phase ${n}`, problem: `Problem ${n}`, done_criteria: [`criterion ${n}`], allowed_paths: allowed,
});

function refusal(answer: Record<string, unknown>): string {
  const r = parseTriage({ ...triageSpec, ...answer });
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}

describe("triage refuses .claude/ paths", () => {
  it("refuses one in allowed_paths, naming the path and why", () => {
    const error = refusal({ allowed_paths: ["docs/", FILE], files_to_change: ["docs/x.md"] });
    expect(error).toContain("allowed_paths");
    expect(error).toContain(FILE);
    expect(error).toContain(".claude/ paths are owner-only");
  });

  it("refuses one in files_to_change the same way", () => {
    const error = refusal({ allowed_paths: [".github/workflows/", ".claude/"], files_to_change: [FILE] });
    expect(error).toContain(".claude/ paths are owner-only");
    const only = refusal({ allowed_paths: [".github/workflows/"], files_to_change: [".github/workflows/a.yml", FILE] });
    expect(only).toContain("files_to_change");
    expect(only).toContain(FILE);
    expect(only).toContain(".claude/ paths are owner-only");
  });

  it("refuses one in a phase's allowed_paths the same way", () => {
    const error = refusal({ phases: [phase(1, ["src/a/"]), phase(2, ["src/b/", FILE])] });
    expect(error).toContain("phases[1].allowed_paths");
    expect(error).toContain(FILE);
    expect(error).toContain(".claude/ paths are owner-only");
  });

  it.each(["./.claude/agents/x.md", ".claude", ".claude/", "./.claude"])("refuses %s the same way", (path) => {
    const error = refusal({ allowed_paths: [".github/workflows/", path], files_to_change: [".github/workflows/scope.yml"] });
    expect(error).toContain(path);
    expect(error).toContain(".claude/ paths are owner-only");
  });

  it("accepts an answer with no .claude/ path, unchanged, including a look-alike name", () => {
    const answer = { ...triageSpec, allowed_paths: ["docs/.claude-notes.md", ".github/workflows/"], phases: [phase(1, ["src/a/"]), phase(2, ["src/b/"])] };
    const r = parseTriage(answer);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.allowed_paths).toEqual(answer.allowed_paths);
      expect(r.value.files_to_change).toEqual(triageSpec.files_to_change);
      expect(r.value.phases?.map((p) => p.allowed_paths)).toEqual([["src/a/"], ["src/b/"]]);
    }
  });
});
