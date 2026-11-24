import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import { parseTriage } from "../src/core/outputs.js";
import { renderSpec } from "../src/core/spec-comment.js";
import { pinTests, quotedStrings } from "../src/core/triage-pins.js";
import type { Run, WorkItem } from "../src/core/types.js";
import type { Worker } from "../src/worker/runner.js";
import type { RunCall } from "../src/worker/run-kind.js";
import triage from "../src/worker/runs/triage/triage.run.js";
import { triageSpec } from "./helpers/fakes/config.js";

// Tests that pin a change (design 04-triage, 2026-11-25): a spec's quoted strings name the base tests asserting them.

/** The base's tests/ files and their text, as the fake run folder's git sees them. */
const BASE: Record<string, string> = {
  "tests/scope-gate.test.ts": `expect(text).toContain("Fails on scope");`,
  "tests/item-page.test.ts": `expect(button).toBe("Approve the spec");`,
};

/** A fake worker whose agent answers `output` and whose git lists BASE (ls-files) and greps it (grep -F), recording each git call. */
function fakeWorker(output: unknown) {
  const git: string[][] = [];
  const w = {
    d: { store: { listStateChanges: async () => [] } },
    gitRaw: async (_h: unknown, args: string[]) => {
      git.push(args);
      const files = Object.keys(BASE);
      if (args[0] === "ls-files") return { exit_code: 0, stdout: files.map((f) => `${f}\0`).join(""), stderr: "" };
      const text = args[args.indexOf("-e") + 1]!;
      const hits = files.filter((f) => BASE[f]!.includes(text));
      return { exit_code: hits.length ? 0 : 1, stdout: hits.map((f) => `${f}\0`).join(""), stderr: "" };
    },
    withIndex: async (prompt: string) => prompt,
    agent: async () => ({ output, transcript: "t" }) as AgentRunResult,
  } as unknown as Worker;
  return { w, git };
}

async function runTriage(output: unknown) {
  const { w, git } = fakeWorker(output);
  const item = { id: "wi_1", source: { link: "https://example.test/1" }, problem: "Rename.", revision_count: 0, allowed_paths: [] } as unknown as WorkItem;
  const call = {
    run: { id: "run_1" } as Run, item, signal: new AbortController().signal, model: "cheap", handle: {},
    step: async (_id: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as RunCall;
  const out = (await triage.execute(w, call)) as { spec: Record<string, unknown> };
  return { spec: out.spec, git };
}

const renaming = {
  ...triageSpec,
  problem: `The approve button says "Approve the spec"; it should say "Approve".`,
  desired_output: `The button reads "Approve now".`,
};

describe("quoted strings of a triage answer", () => {
  it("reads double-quoted strings of four or more characters from the problem, done criteria and desired output, once each", () => {
    const answer = {
      problem: `Rename "Old label" to "New label"; "abc" is too short.`,
      done_criteria: [`The page shows "New label".`, `Nothing shows "Old label" any more.`],
      desired_output: `A view with "Desired text".`,
      tier_reason: `"Not searched here"`,
      in_scope: [`"Nor here"`],
    };
    expect(quotedStrings(answer)).toEqual(["Old label", "New label", "Desired text"]);
  });

  it("reads none from an answer that is not an object", () => {
    expect(quotedStrings("text")).toEqual([]);
    expect(quotedStrings(null)).toEqual([]);
  });
});

describe("tests that pin a triage answer", () => {
  it("adds the base test asserting a renamed string to allowed_paths, files_to_change and pinned_tests", async () => {
    const { spec, git } = await runTriage(renaming);
    expect(spec.allowed_paths).toEqual([...triageSpec.allowed_paths, "tests/item-page.test.ts"]);
    expect(spec.files_to_change).toEqual([...triageSpec.files_to_change, "tests/item-page.test.ts"]);
    expect(spec.pinned_tests).toEqual(["tests/item-page.test.ts"]);
    // Each quoted string is one git grep of the base checkout's tests/ folder, as a fixed string.
    const greps = git.filter((a) => a[0] === "grep");
    for (const text of ["Approve the spec", "Approve", "Approve now"]) {
      expect(greps).toContainEqual(["grep", "--cached", "-l", "-z", "-F", "-e", text, "--", "tests"]);
    }
  });

  it("adds no test file when no quoted string matches a base test", async () => {
    const { spec } = await runTriage({ ...triageSpec, problem: `Rename "Nowhere text" to "Other text".` });
    expect(spec.allowed_paths).toEqual(triageSpec.allowed_paths);
    expect(spec.files_to_change).toEqual(triageSpec.files_to_change);
    expect(spec.pinned_tests).toBeUndefined();
  });

  it("does not search an answer that quotes nothing", async () => {
    const searched: string[] = [];
    const out = await pinTests(triageSpec, async (t) => { searched.push(t); return ["tests/x.test.ts"]; });
    expect(out).toBe(triageSpec);
    expect(searched).toEqual([]);
  });

  it("keeps a covered allowed path and an already listed file once", async () => {
    const answer = { ...triageSpec, problem: `Drop "Fails on scope".`, allowed_paths: ["tests/"], files_to_change: ["tests/scope-gate.test.ts"] };
    const out = (await pinTests(answer, async () => ["tests/scope-gate.test.ts"])) as Record<string, unknown>;
    expect(out.allowed_paths).toEqual(["tests/"]);
    expect(out.files_to_change).toEqual(["tests/scope-gate.test.ts"]);
    expect(out.pinned_tests).toEqual(["tests/scope-gate.test.ts"]);
  });
});

describe("the spec comment's tests that pin this", () => {
  it("lists each matching test file under a \"Tests that pin this\" heading", async () => {
    const { spec } = await runTriage(renaming);
    const parsed = parseTriage(spec); // the controller reads the stored answer again
    if (!parsed.ok) throw new Error(parsed.error);
    const text = renderSpec(parsed.value, 2);
    const at = text.indexOf("### Tests that pin this");
    expect(at).toBeGreaterThan(text.indexOf("### Files"));
    expect(text.slice(at)).toContain("- `tests/item-page.test.ts`");
  });

  it("has no such heading when no test pins the spec", () => {
    const parsed = parseTriage(triageSpec);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(renderSpec(parsed.value, 2)).not.toContain("Tests that pin this");
  });

  it("refuses a pinned test that files_to_change does not list", () => {
    expect(parseTriage({ ...triageSpec, pinned_tests: ["tests/other.test.ts"] })).toMatchObject({ ok: false, error: expect.stringContaining("pinned_tests") });
  });
});
