import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_SCHEMA, TRIAGE_SCHEMA, parseTriage } from "../src/core/outputs.js";
import { TRIAGE_PARTS } from "../src/golden.js";
import { type TriageCheck, failedCheck, loadTriageCases, triageReplayRunner } from "../src/controller/golden-gate/triage-replay.js";
import { triageSpec } from "./helpers/fakes/config.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sf-triage-replay-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const rolesDir = () => join(tmp, "roles");

async function writeTriageCase(id: string, meta: Record<string, unknown>) {
  const dir = join(rolesDir(), "triage", "golden", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "instruction.md"), `intake for ${id}`);
  await writeFile(join(dir, "case.json"), JSON.stringify({ id, expect: "should_pass", ...meta }));
}

const QUESTION = { question: "Which store?", default: "sqlite", owner_only: false, reason: "the intake names two stores" };
const PHASES = [
  { title: "one", problem: "p1", done_criteria: ["a"], allowed_paths: ["src/a.ts"] },
  { title: "two", problem: "p2", done_criteria: ["b"], allowed_paths: ["src/b.ts"] },
];
const parsed = (over: Record<string, unknown> = {}) => {
  const r = parseTriage({ ...triageSpec, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("triage checks", () => {
  it("decides each kind from the parsed answer", () => {
    const plain = parsed();
    const asking = parsed({ decisions: [QUESTION] });
    const split = parsed({ phases: PHASES, goal_done_when: ["CI fails when files outside allowed_paths change"] });
    const run = (c: TriageCheck, a = plain) => failedCheck(c, a, TRIAGE_PARTS.covered);
    expect(run({ kind: "asks_question" }, asking)).toBeNull();
    expect(run({ kind: "asks_question" })).toMatch(/^asks_question/);
    expect(run({ kind: "no_question" })).toBeNull();
    expect(run({ kind: "no_question" }, asking)).toMatch(/^no_question/);
    expect(run({ kind: "splits" }, split)).toBeNull();
    expect(run({ kind: "splits" })).toMatch(/^splits/);
    expect(run({ kind: "names_paths", paths: [".github/workflows/scope.yml"] })).toBeNull();
    expect(run({ kind: "names_paths", paths: [".github/workflows/scope.yml", "src/x.ts"] })).toBe("names_paths: not allowed: src/x.ts");
    expect(run({ kind: "refuses_scope", paths: ["src/x.ts"] })).toBeNull();
    expect(run({ kind: "refuses_scope", paths: [".github/workflows/a.yml"] })).toBe("refuses_scope: allowed: .github/workflows/a.yml");
  });

  it("refuses at load a case with an unknown kind, an empty or missing checks list, or a path kind with no paths, naming the case", async () => {
    await writeTriageCase("good", { checks: [{ kind: "no_question" }, { kind: "names_paths", paths: ["src/a.ts"] }] });
    expect([...loadTriageCases(rolesDir()).values()].map((c) => [c.id, c.checks])).toEqual([["good", [{ kind: "no_question" }, { kind: "names_paths", paths: ["src/a.ts"] }]]]);
    for (const [id, checks, msg] of [
      ["unknown", [{ kind: "guesses" }], /triage case unknown: checks\[0\] has unknown kind "guesses"/],
      ["empty", [], /triage case empty: checks must be a non-empty list/],
      ["absent", undefined, /triage case absent: checks must be a non-empty list/],
      ["nopaths", [{ kind: "refuses_scope" }], /triage case nopaths: checks\[0\] \(refuses_scope\) needs a non-empty paths list/],
    ] as const) {
      await rm(join(rolesDir(), "triage"), { recursive: true, force: true });
      await writeTriageCase(id, { checks });
      expect(() => loadTriageCases(rolesDir())).toThrow(msg);
    }
  });
});

describe("triage replay runner", () => {
  type Spec = { role: string; work_item_id: string; prompt: string; output_schema?: Record<string, unknown> };
  const fake = (output: unknown, status = "completed") => {
    const specs: Spec[] = [];
    return { specs, run: async (s: Spec) => (specs.push(s), { status, output }) };
  };
  const spec = (over: Partial<Spec> = {}): Spec => ({ role: "triage", work_item_id: "golden_c1", prompt: "spec\n\n## Diff\n\n...", output_schema: REVIEW_SCHEMA, ...over });

  it("runs the case's instruction.md alone with TRIAGE_SCHEMA and answers as a review from the checks", async () => {
    await writeTriageCase("c1", { checks: [{ kind: "asks_question" }] });
    const pass = fake({ ...triageSpec, decisions: [QUESTION] });
    const r = await triageReplayRunner(pass, rolesDir(), TRIAGE_PARTS).run(spec());
    expect(pass.specs[0]).toMatchObject({ prompt: "intake for c1", output_schema: TRIAGE_SCHEMA });
    expect(r.output).toEqual({ verdict: "pass", tier: 5, findings: [], summary: "triage replay of case c1" });
    const miss = await triageReplayRunner(fake(triageSpec), rolesDir(), TRIAGE_PARTS).run(spec());
    expect(miss.output).toMatchObject({ verdict: "bug", findings: ["asks_question: the spec asks no question"] });
  });

  it("throws (an errored replay) on an answer parseTriage refuses, and passes other runs and failed runs through", async () => {
    await writeTriageCase("c1", { checks: [{ kind: "no_question" }] });
    await expect(triageReplayRunner(fake({ problem: "only" }), rolesDir(), TRIAGE_PARTS).run(spec())).rejects.toThrow(/triage replay of case c1: invalid answer/);
    const failed = await triageReplayRunner(fake(null, "failed"), rolesDir(), TRIAGE_PARTS).run(spec());
    expect(failed).toEqual({ status: "failed", output: null });
    const other = fake("as is");
    expect((await triageReplayRunner(other, rolesDir(), TRIAGE_PARTS).run(spec({ role: "review" }))).output).toBe("as is");
    expect(other.specs[0]!.output_schema).toBe(REVIEW_SCHEMA);
  });
});
