import { describe, expect, it } from "vitest";
import { parseTriage, TRIAGE_SCHEMA, type TriageOutput } from "../src/core/outputs.js";
import { renderSpec } from "../src/core/spec-comment.js";

const IN_SHORT =
  "AS-IS: a pull request can change any file and nothing stops it.\nTO-BE: CI fails when a pull request changes a file outside its scope.";

const spec: TriageOutput = {
  in_short: IN_SHORT,
  problem:
    "Pull requests can touch files outside their scope. Nothing checks it today. The worker trusts src/core/worker.ts line 40 blindly.",
  done_criteria: ["A CI job fails when a file is outside the allowed paths.", "The job runs on every pull request."],
  desired_output: "A workflow file and a short note in the docs.",
  scope: "Only the CI check. Not the review agent.",
  allowed_paths: [".github/workflows/", "docs/ci.md"],
  files_to_change: [".github/workflows/scope.yml", "docs/ci.md"],
  tier: 2,
  tier_reason: "A small CI change.",
  estimated_lines: 60,
  estimated_files: 2,
};

const HEADINGS = ["### In short (AS-IS → TO-BE)", "### What changes", "### Done when", "### Not included", "### Files", "### Risk"];
const FOOTER =
  "Reply `/approve` to start implementation, `/reject <reason>` to close, or `/revise <feedback>` to get a new spec.";

function lines(body: string): string[] {
  return body.split("\n");
}

describe("renderSpec", () => {
  it("opens with the heading, then the In short section, then the in_short text, nothing before them", () => {
    const body = renderSpec(spec, 2);
    const l = lines(body);
    expect(l[0]).toBe("## Factory spec");
    const rest = l.slice(1).filter((x) => x.trim() !== "");
    expect(rest[0]).toBe("### In short (AS-IS → TO-BE)");
    expect(body).toContain(`## Factory spec\n\n### In short (AS-IS → TO-BE)\n${IN_SHORT}\n`);
  });

  it("no longer opens with the first sentences of the problem", () => {
    const body = renderSpec(spec, 2);
    const firstHeading = lines(body).slice(1).findIndex((x) => x.startsWith("### "));
    expect(firstHeading).toBeGreaterThanOrEqual(0);
    expect(lines(body).slice(1, firstHeading + 1).join("\n")).not.toContain("Pull requests can touch files");
    expect(body.indexOf("Pull requests can touch files")).toBeGreaterThan(body.indexOf("### Not included"));
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

  it("shows Please check after the In short section when a floor raised the tier", () => {
    const body = renderSpec(spec, 4, { floor: 4, previous: null });
    const l = lines(body);
    const check = l.indexOf("### Please check");
    const inShort = l.indexOf("### In short (AS-IS → TO-BE)");
    expect(l.slice(1).find((x) => x.trim() !== "")).toBe("### In short (AS-IS → TO-BE)");
    expect(inShort).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(inShort);
    expect(check).toBeLessThan(l.indexOf("### What changes"));
    expect(l.slice(inShort + 1, check).filter((x) => x.trim() !== "")).toEqual(IN_SHORT.split("\n"));
    expect(body).toContain("- Tier raised from 2 to 4 because a path is under a floor.");
    expect(body).toContain("### Risk\nTier 4: A small CI change.");
    expect(l.at(-1)).toBe(FOOTER);
  });

  it("names a previous tier as the reason when no floor applies", () => {
    expect(renderSpec(spec, 3, { floor: null, previous: 3 })).toContain(
      "- Tier raised from 2 to 3 because the work item already had tier 3, and a tier is never lowered.",
    );
  });

  it("keeps the problem in a Problem section after Not included", () => {
    const body = renderSpec(spec, 2);
    expect(body).toContain(`### Problem\n${spec.problem}`);
    expect(lines(body).indexOf("### Problem")).toBeGreaterThan(lines(body).indexOf("### Not included"));
    expect(lines(body).indexOf("### Problem")).toBeLessThan(lines(body).indexOf("### Files"));
  });

  it("handles an empty files_to_change", () => {
    const body = renderSpec({ ...spec, files_to_change: [] }, 2);
    expect(body).not.toContain("Expected to change:");
    expect(lines(body).at(-1)).toBe(FOOTER);
  });
});

describe("triage in_short", () => {
  it("is a required text field in the schema and the validator", () => {
    expect(TRIAGE_SCHEMA.required).toContain("in_short");
    expect(TRIAGE_SCHEMA.properties.in_short).toEqual({ type: "string" });
    const { in_short: _omit, ...without } = spec;
    expect(parseTriage(without).ok).toBe(false);
    expect(parseTriage({ ...spec, in_short: 3 }).ok).toBe(false);
  });

  it("is kept in the validated output", () => {
    const r = parseTriage(spec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.in_short).toBe(IN_SHORT);
  });
});
