import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseTriage, scopeText, TRIAGE_SCHEMA, type TriageOutput } from "../src/core/outputs.js";
import { renderSpec, repeatsDone } from "../src/core/spec-comment.js";

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

const HEADINGS = [
  "### In short (AS-IS → TO-BE)", "### Problem", "### Decisions for you", "### Done when", "### In scope", "### Out of scope", "### Files", "### Risk",
];
const FOOTER =
  "Reply `/approve` to start implementation, `/reject <reason>` to close, or `/revise <feedback>` to get a new spec.";

/** A triage answer in the current shape: separate scope lists and decisions. */
const listed: TriageOutput = {
  ...spec,
  in_scope: ["The CI check."],
  out_of_scope: ["The review agent."],
  scope: scopeText(["The CI check."], ["The review agent."]),
  decisions: ["Fail the job, or only warn, on a docs-only change?"],
};

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

  it("puts Problem second and Decisions for you third, the sections in order and the footer last", () => {
    const body = renderSpec(listed, 3, { floor: 3, previous: null });
    const headings = lines(body).filter((x) => x.startsWith("### "));
    expect(headings).toEqual(HEADINGS);
    expect(lines(body).at(-1)).toBe(FOOTER);
  });

  it("fills each section from the spec", () => {
    const body = renderSpec(listed, 2);
    expect(body).toContain(`### Problem\n${spec.problem}`);
    expect(body).toContain("### Decisions for you\n- Fail the job, or only warn, on a docs-only change?");
    expect(body).toContain(
      "### Done when\n- A CI job fails when a file is outside the allowed paths.\n- The job runs on every pull request.",
    );
    expect(body).toContain("### In scope\n- The CI check.");
    expect(body).toContain("### Out of scope\n- The review agent.");
    expect(body).toContain("- `.github/workflows/`\n- `docs/ci.md`");
    expect(body).toContain("`.github/workflows/scope.yml`");
    expect(body).toContain("### Risk\nTier 2: A small CI change.");
    expect(body).not.toContain("Not included");
  });

  it("renders an older output's single scope text under Scope", () => {
    const body = renderSpec(spec, 2);
    expect(body).toContain("### Scope\nOnly the CI check. Not the review agent.");
    expect(body).not.toContain("### Out of scope");
  });

  it("shows at most 10 done criteria; the rest go in a collapsed block", () => {
    const done = Array.from({ length: 13 }, (_, i) => `Criterion ${i + 1} holds.`);
    const body = renderSpec({ ...spec, done_criteria: done }, 2);
    const section = body.slice(body.indexOf("### Done when"), body.indexOf("### Scope"));
    const visible = section.slice(0, section.indexOf("<details>"));
    expect(visible.match(/^- /gm)).toHaveLength(10);
    expect(section).toContain("<details><summary>3 more done criteria</summary>");
    expect(section).toContain("- Criterion 13 holds.");
    expect(renderSpec(spec, 2)).not.toContain("more done criteria");
  });

  it("shows at most 5 decision lines, the tier raise first", () => {
    const decisions = Array.from({ length: 6 }, (_, i) => `Question ${i + 1}?`);
    const body = renderSpec({ ...listed, decisions }, 4, { floor: 4, previous: null });
    const section = body.slice(body.indexOf("### Decisions for you"), body.indexOf("### Done when"));
    expect(section).toContain("### Decisions for you\n- Tier raised from 2 to 4 because a path is under a floor.\n- Question 1?");
    expect(section.slice(0, section.indexOf("<details>")).match(/^- /gm)).toHaveLength(5);
    expect(section).toContain("<details><summary>2 more</summary>");
  });

  it("omits Decisions for you when the tier was not raised and triage named none", () => {
    expect(renderSpec(spec, 2)).not.toContain("Decisions for you");
    expect(renderSpec(spec, 2, { floor: 2, previous: null })).not.toContain("Decisions for you");
  });

  it("names a previous tier as the reason when no floor applies", () => {
    expect(renderSpec(spec, 3, { floor: null, previous: 3 })).toContain(
      "- Tier raised from 2 to 3 because the work item already had tier 3, and a tier is never lowered.",
    );
  });

  it("drops What changes when it repeats the done list, and folds it otherwise", () => {
    const repeat = { ...spec, desired_output: "A CI job that fails on a file outside the allowed paths, on every pull request." };
    expect(renderSpec(repeat, 2)).not.toContain("What the PR contains");
    const body = renderSpec(spec, 2);
    expect(body).toContain("<details><summary>What the PR contains</summary>\n\nA workflow file and a short note in the docs.");
    expect(body).not.toContain("### What changes");
    expect(repeatsDone("", spec.done_criteria)).toBe(true);
  });

  it("handles an empty files_to_change", () => {
    const body = renderSpec({ ...spec, files_to_change: [] }, 2);
    expect(body).not.toContain("Expected to change:");
    expect(lines(body).at(-1)).toBe(FOOTER);
  });
});

describe("triage scope lists and decisions", () => {
  const { scope: _s, ...noScope } = spec;
  const current = { ...noScope, in_scope: ["The CI check."], out_of_scope: ["The review agent."], decisions: [] };

  it("the schema asks for in_scope and out_of_scope, not scope", () => {
    expect(TRIAGE_SCHEMA.required).toEqual(expect.arrayContaining(["in_scope", "out_of_scope"]));
    expect(TRIAGE_SCHEMA.required).not.toContain("scope");
    expect(TRIAGE_SCHEMA.properties).not.toHaveProperty("scope");
  });

  it("the validator keeps both lists and derives the stored scope text from them", () => {
    const r = parseTriage(current);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.in_scope).toEqual(["The CI check."]);
    expect(r.value.out_of_scope).toEqual(["The review agent."]);
    expect(r.value.scope).toBe("In scope:\n- The CI check.\n\nOut of scope:\n- The review agent.");
    expect(r.value.decisions).toEqual([]);
  });

  it("decisions is optional: the schema the runner gets does not require it, and a missing one parses as []", () => {
    // A cheap model leaves an empty list out; requiring it failed every structured-output retry.
    expect(TRIAGE_SCHEMA.required).not.toContain("decisions");
    expect(TRIAGE_SCHEMA.properties).toHaveProperty("decisions");
    const { decisions: _d, ...without } = current;
    const r = parseTriage(without);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decisions).toEqual([]);
  });

  it("the other triage fields stay required", () => {
    expect([...TRIAGE_SCHEMA.required].sort()).toEqual([
      "allowed_paths", "desired_output", "done_criteria", "estimated_files", "estimated_lines", "files_to_change", "in_scope",
      "in_short", "out_of_scope", "problem", "tier", "tier_reason",
    ]);
  });

  it("the prompt's output example includes decisions", () => {
    const prompt = readFileSync(new URL("../prompts/triage.md", import.meta.url), "utf8");
    expect(prompt).toContain('"decisions": []');
  });

  it("still reads an older output with only scope", () => {
    const r = parseTriage(spec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scope).toBe(spec.scope);
  });

  it("rejects one list without the other, or bad decisions", () => {
    const { out_of_scope: _o, ...half } = current;
    expect(parseTriage(half).ok).toBe(false);
    expect(parseTriage({ ...current, decisions: "x" }).ok).toBe(false);
    expect(parseTriage({ ...current, decisions: ["Ship behind a flag?"] })).toMatchObject({ ok: true, value: { decisions: ["Ship behind a flag?"] } });
  });
});

describe("triage applied_defaults (issue #315)", () => {
  const { scope: _s, ...noScope } = spec;
  const current = { ...noScope, in_scope: ["The CI check."], out_of_scope: ["The review agent."], decisions: [] };
  const RULE = "tier 4 needs a human merge";

  it("the schema has an optional, capped list of strings", () => {
    expect(TRIAGE_SCHEMA.required).not.toContain("applied_defaults");
    expect(TRIAGE_SCHEMA.properties.applied_defaults).toMatchObject({ type: "array", items: { type: "string" } });
    expect(TRIAGE_SCHEMA.properties.applied_defaults.maxItems).toBeGreaterThan(0);
  });

  it("parses an absent list as empty and rejects a non-list or a non-string entry", () => {
    const r = parseTriage(current);
    expect(r.ok && r.value.applied_defaults).toEqual([]);
    expect(parseTriage({ ...current, applied_defaults: RULE }).ok).toBe(false);
    expect(parseTriage({ ...current, applied_defaults: [RULE, 3] }).ok).toBe(false);
  });

  it("an answer with an applied default and no decision renders the rule under Applied defaults only", () => {
    const r = parseTriage({ ...current, applied_defaults: [RULE] });
    if (!r.ok) throw new Error(r.error);
    const body = renderSpec(r.value, r.value.tier);
    expect(body).not.toContain("### Decisions for you");
    expect(body).toContain(`### Applied defaults\n- ${RULE}\n`);
  });

  it("puts Applied defaults right after Decisions for you, and omits it when empty", () => {
    const body = renderSpec({ ...listed, applied_defaults: [RULE, "caches may stay in process"] }, 2);
    const headings = lines(body).filter((x) => x.startsWith("### "));
    expect(headings[headings.indexOf("### Decisions for you") + 1]).toBe("### Applied defaults");
    expect(body).toContain(`### Applied defaults\n- ${RULE}\n- caches may stay in process\n`);
    expect(renderSpec({ ...listed, applied_defaults: [] }, 2)).not.toContain("### Applied defaults");
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

describe("triage tool-call markup (issue #454)", () => {
  const { scope: _s, ...noScope } = spec;
  const current = { ...noScope, in_scope: ["The CI check."], out_of_scope: ["The review agent."], decisions: [] };
  const PARAM = '<parameter name="decisions">';
  const NS_TAG = `<${"antml"}:invoke name="x">`;
  const phase = (n: number) => ({ title: `Phase ${n}`, problem: "A problem.", done_criteria: ["It holds."], allowed_paths: ["docs/"] });
  const split = { ...current, phases: [phase(1), phase(2)] };

  function refused(answer: unknown, field: string): void {
    const r = parseTriage(answer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.startsWith(`${field}:`)).toBe(true);
  }

  it("refuses decisions sent as a JSON string, naming decisions", () => {
    refused({ ...current, decisions: JSON.stringify(["Ship it?"]) }, "decisions");
  });

  it("refuses a decisions entry that holds parameter markup, naming decisions", () => {
    refused({ ...current, decisions: [`Ship it?</problem>\n${PARAM}["x"]`] }, "decisions");
  });

  it("refuses markup in every other text field, naming the field", () => {
    const bad = `Text ${PARAM} more`;
    refused({ ...current, in_short: bad }, "in_short");
    refused({ ...current, problem: `x</problem>\n${NS_TAG}` }, "problem");
    refused({ ...current, desired_output: "<invoke name=\"Write\">" }, "desired_output");
    refused({ ...current, tier_reason: "</function_calls>" }, "tier_reason");
    refused({ ...spec, scope: bad }, "scope");
    refused({ ...current, in_scope: ["ok", bad] }, "in_scope");
    refused({ ...current, out_of_scope: [bad] }, "out_of_scope");
    refused({ ...current, done_criteria: [bad] }, "done_criteria");
    refused({ ...current, applied_defaults: [bad] }, "applied_defaults");
    refused({ ...split, phases: [phase(1), { ...phase(2), title: bad }] }, "phases[1].title");
    refused({ ...split, phases: [{ ...phase(1), problem: bad }, phase(2)] }, "phases[0].problem");
    refused({ ...split, phases: [phase(1), { ...phase(2), done_criteria: [bad] }] }, "phases[1].done_criteria");
    expect(parseTriage(split).ok).toBe(true);
  });

  it("accepts markup quoted in backticks", () => {
    const r = parseTriage({ ...current, problem: `The parser lets \`${PARAM}\` through.`, decisions: [`Must \`${NS_TAG}\` pass?`] });
    expect(r.ok).toBe(true);
  });

  it("accepts markup inside a fenced code block, and refuses bare markup after the fence", () => {
    const fenced = `Issue #446 showed:\n\n\`\`\`\n</problem>\n${PARAM}["x"]\n\`\`\`\n`;
    expect(parseTriage({ ...current, problem: fenced }).ok).toBe(true);
    refused({ ...current, problem: `${fenced}and then ${PARAM}` }, "problem");
  });

  it("renders a valid decisions list as a plain bullet list with no markup", () => {
    const r = parseTriage({ ...current, decisions: ["Fail the job, or only warn?", "Ship behind a flag?"] });
    if (!r.ok) throw new Error(r.error);
    const body = renderSpec(r.value, r.value.tier);
    expect(body).toContain("### Decisions for you\n- Fail the job, or only warn?\n- Ship behind a flag?\n");
    expect(body).not.toMatch(/<\/?(parameter|invoke|function_calls)\b/);
    expect(body).not.toContain(`${"antml"}:`);
  });
});
