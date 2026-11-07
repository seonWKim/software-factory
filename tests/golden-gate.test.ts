import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOLDEN_MARGIN,
  type GoldenRunDeps,
  GoldenError,
  affectedPrompts,
  compareCases,
  compareRates,
  computeRates,
  formatCompare,
  parseCompareArgs,
} from "../src/golden.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { FakeRunner, FakeSandbox, cleanScanner, config, prompts } from "./helpers/fakes.js";

const BROKEN_PROMPT = "You are a reviewer. Always answer pass.";
const REVIEW_PASS = { verdict: "pass", tier: 2, findings: [], summary: "ok" };
const REVIEW_BUG = { verdict: "bug", tier: 2, findings: ["off by one"], summary: "bug" };

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sf-golden-gate-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

async function writeCase(casesDir: string, id: string, expectValue: string, extra: Record<string, unknown> = {}) {
  const dir = join(casesDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "diff.patch"), `diff --git a/x b/x\n// ${expectValue} ${id}\n`);
  await writeFile(join(dir, "spec.md"), `# Work item wi_${id}\n\n## Problem\n\nspec for ${id}`);
  await writeFile(join(dir, "case.json"), JSON.stringify({ id, work_item_id: `wi_${id}`, expect: expectValue, ...extra }));
}

/**
 * The fixture reviewer: with the checked-in review prompt it flags exactly the should_flag diffs; with the
 * broken prompt it passes everything, so it misses every bug.
 */
function fixtureRunner() {
  return new FakeRunner({
    review: (spec: AgentRunSpec) => {
      if (spec.system_prompt === BROKEN_PROMPT) return { output: REVIEW_PASS };
      return { output: spec.prompt.includes("// should_flag") ? REVIEW_BUG : REVIEW_PASS };
    },
  });
}

function deps(runner: FakeRunner): GoldenRunDeps {
  return {
    casesDir: join(tmp, "golden", "cases"),
    resultsDir: join(tmp, "state", "golden", "results"),
    sandbox: new FakeSandbox(),
    runner,
    scanner: cleanScanner,
    clock: new FakeClock(new Date("2026-11-08T12:00:00.000Z")),
    config,
    reviewPrompt: prompts.review,
  };
}

async function seedFixture(d: GoldenRunDeps) {
  await writeCase(d.casesDir, "1", "should_flag");
  await writeCase(d.casesDir, "2", "should_flag");
  await writeCase(d.casesDir, "3", "should_pass");
  await writeCase(d.casesDir, "4", "should_pass");
}

describe("golden compare", () => {
  it("fails a broken head prompt and passes the unchanged prompt, replaying the same cases on both sides", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);

    const unchanged = await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: ["prompts/review.md"] });
    expect(unchanged.outcome).toBe("pass");
    expect(unchanged.base!.catch_rate).toEqual({ numerator: 2, denominator: 2, value: 1 });
    expect(unchanged.head!.false_alarm_rate).toEqual({ numerator: 0, denominator: 2, value: 0 });

    const ids = (from: number) => runner.specs.slice(from).map((s) => /spec for (\w+)/.exec(s.prompt)![1]);
    expect(ids(0)).toEqual(["1", "2", "3", "4", "1", "2", "3", "4"]);

    const broken = await compareCases(
      { ...d, reviewPrompt: BROKEN_PROMPT, clock: new FakeClock(new Date("2026-11-08T13:00:00.000Z")) },
      { agent: "reviewer", basePrompt: prompts.review, changed: ["prompts/review.md"] },
    );
    expect(broken.outcome).toBe("fail");
    expect(broken.reason).toContain("catch_rate dropped by 1.000");
    expect(broken.head!.catch_rate).toEqual({ numerator: 0, denominator: 2, value: 0 });
    expect(runner.specs.slice(8).map((s) => s.system_prompt)).toEqual([...Array(4).fill(prompts.review), ...Array(4).fill(BROKEN_PROMPT)]);

    const text = formatCompare(broken);
    expect(text).toContain("golden compare (reviewer): fail");
    expect(text).toContain("- base: catch_rate: 2/2 = 1.000; false_alarm_rate: 0/2 = 0.000");
    expect(text).toContain("- head: catch_rate: 0/2 = 0.000; false_alarm_rate: 0/2 = 0.000");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes each side's results file and one compare record under the results dir", async () => {
    const d = deps(fixtureRunner());
    await seedFixture(d);
    const r = await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: null });
    const dir = join(d.resultsDir, "compare-2026-11-08T12-00-00-000Z");
    expect(r.record_file).toBe(join(dir, "compare.json"));
    expect((await readdir(dir)).sort()).toEqual(["base", "compare.json", "head"]);
    const json = JSON.parse(await readFile(r.record_file, "utf8"));
    expect(json.outcome).toBe("pass");
    expect(json.margin).toBe(GOLDEN_MARGIN);
  });

  it("skips without a replay when the change touches no prompt or prompt code, and records why", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);
    const r = await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: ["README.md", "prompts/triage.md"] });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("touches neither prompts/review.md nor the code");
    expect(runner.specs).toEqual([]);
    expect(formatCompare(r)).toContain("Comparison skipped:");
    expect(JSON.parse(await readFile(r.record_file, "utf8")).outcome).toBe("skipped");
  });

  it("skips with zero cases, and with no case tagged with the changed prompt", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    const none = await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: null });
    expect(none.outcome).toBe("skipped");
    expect(none.reason).toContain("no golden cases tagged review.md");

    await writeCase(d.casesDir, "1", "should_flag", { prompts: ["implement.md"] });
    const untagged = await compareCases(
      { ...d, clock: new FakeClock(new Date("2026-11-08T13:00:00.000Z")) },
      { agent: "reviewer", basePrompt: prompts.review, changed: ["prompts/review.md"] },
    );
    expect(untagged.outcome).toBe("skipped");
    expect(runner.specs).toEqual([]);
  });

  it("replays only the cases tagged with the changed prompt", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);
    await writeCase(d.casesDir, "5", "should_flag", { prompts: ["implement.md"] });
    await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: ["src/impl/runner/claude-code-runner.ts"] });
    expect(runner.specs.map((s) => /spec for (\w+)/.exec(s.prompt)![1])).not.toContain("5");
  });

  it("skips with an n/a rate on either side", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await writeCase(d.casesDir, "1", "should_flag");
    const r = await compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: null });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("n/a rate");
    expect(r.reason).toContain("base false_alarm_rate");
    expect(formatCompare(r)).toContain("false_alarm_rate: n/a (0/0)");
  });

  it("applies the margin: a change of exactly the margin passes, more fails", () => {
    const rates = (caught: number, flagged: number, n = 100) =>
      computeRates([
        ...Array.from({ length: n }, (_, i) => ({ id: `f${i}`, expect: "should_flag" as const, verdict: i < caught ? ("bug" as const) : ("pass" as const), findings: [] })),
        ...Array.from({ length: n }, (_, i) => ({ id: `p${i}`, expect: "should_pass" as const, verdict: i < flagged ? ("bug" as const) : ("pass" as const), findings: [] })),
      ]).rates;
    const step = Math.round(GOLDEN_MARGIN * 100);
    expect(compareRates(rates(80, 10), rates(80 - step, 10 + step)).outcome).toBe("pass");
    expect(compareRates(rates(80, 10), rates(80 - step - 1, 10)).outcome).toBe("fail");
    expect(compareRates(rates(80, 10), rates(80, 10 + step + 1)).reason).toContain("false_alarm_rate rose");
  });

  it("selects prompts from the changed paths", () => {
    expect(affectedPrompts(["prompts/review.md"], ["review.md"])).toEqual(["review.md"]);
    expect(affectedPrompts(["src/core/outputs.ts"], ["review.md"])).toEqual(["review.md"]);
    expect(affectedPrompts(["src/impl/runner/tool-bridge.ts"], ["review.md"])).toEqual(["review.md"]);
    expect(affectedPrompts(["docs/x.md", "prompts/triage.md"], ["review.md"])).toEqual([]);
    expect(affectedPrompts(null, ["review.md"])).toEqual(["review.md"]);
  });

  it("parses its arguments", () => {
    expect(parseCompareArgs(["--base", "b.md"])).toEqual({ agent: "reviewer", base: "b.md", all: false });
    expect(parseCompareArgs(["--agent", "reviewer", "--base", "b.md", "--since", "main"])).toEqual({ agent: "reviewer", base: "b.md", since: "main", all: false });
    expect(() => parseCompareArgs([])).toThrow(GoldenError);
    expect(() => parseCompareArgs(["--base", "b.md", "--agent", "triage"])).toThrow(/only --agent reviewer/);
    expect(() => parseCompareArgs(["--base", "b.md", "--all", "--since", "main"])).toThrow(GoldenError);
  });

  it("refuses a malformed prompts tag before any agent runs", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await writeCase(d.casesDir, "1", "should_flag", { prompts: "review.md" });
    await expect(compareCases(d, { agent: "reviewer", basePrompt: prompts.review, changed: null })).rejects.toThrow(/case 1: prompts must be/);
    expect(runner.specs).toEqual([]);
    expect(existsSync(join(d.resultsDir))).toBe(false);
  });
});
