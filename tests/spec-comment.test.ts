import { describe, expect, it } from "vitest";
import type { TriageOutput } from "../src/core/outputs.js";
import { renderSpec } from "../src/core/spec-comment.js";

const spec: TriageOutput = {
  problem:
    "Pull requests can touch files outside their scope. Nothing checks it today. The worker trusts src/core/worker.ts line 40 blindly.",
  done_criteria: ["A CI job fails when a file is outside the allowed paths.", "The job runs on every pull request."],
  desired_output: "A workflow file and a short note in the docs.",
  scope: "Only the CI check. Not the review agent.",
  allowed_paths: [".github/workflows/", "docs/ci.md"],
  files_to_change: [".github/workflows/scope.yml", "docs/ci.md"],
  tier: 2,
  tier_reason: "A small CI change.",
};

const HEADINGS = ["### What changes", "### Done when", "### Not included", "### Files", "### Risk"];
const FOOTER =
  "Reply `/approve` to start implementation, `/reject <reason>` to close, or `/revise <feedback>` to get a new spec.";

function lines(body: string): string[] {
  return body.split("\n");
}

describe("renderSpec", () => {
  it("opens with the heading and the first two sentences of the problem, no section heading before them", () => {
    const l = lines(renderSpec(spec, 2));
    expect(l[0]).toBe("## Factory spec");
    const firstText = l.slice(1).find((x) => x.trim() !== "")!;
    expect(firstText).toBe("Pull requests can touch files outside their scope. Nothing checks it today.");
    expect(renderSpec(spec, 2)).not.toContain("line 40");
  });

  it("puts the sections in order and the footer last", () => {
    const body = renderSpec(spec, 2);
    const at = HEADINGS.map((h) => lines(body).indexOf(h));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines(body).at(-1)).toBe(FOOTER);
  });

  it("fills each section from the spec", () => {
    const body = renderSpec(spec, 2);
    expect(body).toContain("### What changes\nA workflow file and a short note in the docs.");
    expect(body).toContain(
      "### Done when\n- A CI job fails when a file is outside the allowed paths.\n- The job runs on every pull request.",
    );
    expect(body).toContain("### Not included\nOnly the CI check. Not the review agent.");
    expect(body).toContain("- `.github/workflows/`\n- `docs/ci.md`");
    expect(body).toContain("`.github/workflows/scope.yml`");
    expect(body).toContain("### Risk\nTier 2: A small CI change.");
  });

  it("omits Please check when the tier was not raised", () => {
    expect(renderSpec(spec, 2)).not.toContain("Please check");
    expect(renderSpec(spec, 2, { floor: 2, previous: null })).not.toContain("Please check");
  });

  it("shows Please check right after the opening sentences when a floor raised the tier", () => {
    const body = renderSpec(spec, 4, { floor: 4, previous: null });
    const l = lines(body);
    const check = l.indexOf("### Please check");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(l.indexOf("### What changes"));
    expect(l.slice(1, check).filter((x) => x.trim() !== "")).toEqual([
      "Pull requests can touch files outside their scope. Nothing checks it today.",
    ]);
    expect(body).toContain("- Tier raised from 2 to 4 because a path is under a floor.");
    expect(body).toContain("### Risk\nTier 4: A small CI change.");
    expect(l.at(-1)).toBe(FOOTER);
  });

  it("names a previous tier as the reason when no floor applies", () => {
    expect(renderSpec(spec, 3, { floor: null, previous: 3 })).toContain(
      "- Tier raised from 2 to 3 because the work item already had tier 3, and a tier is never lowered.",
    );
  });

  it("handles a one-sentence problem and an empty files_to_change", () => {
    const body = renderSpec({ ...spec, problem: "Short problem", files_to_change: [] }, 2);
    expect(lines(body)[2]).toBe("Short problem");
    expect(lines(body).at(-1)).toBe(FOOTER);
  });
});
