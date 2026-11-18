import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  replayCases,
} from "../src/golden.js";
import { EVAL_REGRESSION, type GoldenGateDeps, checkChange, fingerprint } from "../src/controller/golden-gate/golden-gate.js";
import { goldenConfig } from "../src/core/config.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import implementRole from "../src/worker/roles/implement.role.js";
import { REPO } from "./architecture/lib.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { RoleCatalog } from "../src/runtime/index.js";
import reviewRole from "../src/worker/roles/review.role.js";
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

const casesDir = () => join(tmp, "src", "worker", "roles", "review", "golden");

async function writeCase(dirOfCases: string, id: string, expectValue: string, extra: Record<string, unknown> = {}) {
  const dir = join(dirOfCases, id);
  await mkdir(join(dir, "environment"), { recursive: true });
  await writeFile(join(dir, "environment", "diff.patch"), `diff --git a/x b/x\n// ${expectValue} ${id}\n`);
  await writeFile(join(dir, "instruction.md"), `# Work item wi_${id}\n\n## Problem\n\nspec for ${id}`);
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
    rolesDir: join(tmp, "src", "worker", "roles"),
    roles: new RoleCatalog([{ file: "worker/roles/review.role.ts", descriptor: reviewRole }]),
    prompt: async () => prompts.review,
    resultsDir: join(tmp, "state", "golden", "results"),
    sandbox: new FakeSandbox(),
    runner,
    scanner: cleanScanner,
    clock: new FakeClock(new Date("2026-11-08T12:00:00.000Z")),
    config,
  };
}

async function seedFixture(d: GoldenRunDeps) {
  await writeCase(casesDir(), "1", "should_flag");
  await writeCase(casesDir(), "2", "should_flag");
  await writeCase(casesDir(), "3", "should_pass");
  await writeCase(casesDir(), "4", "should_pass");
}

describe("golden compare", () => {
  it("fails a broken head prompt and passes the unchanged prompt, replaying the same cases on both sides", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);

    const unchanged = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: ["prompts/review.md"] });
    expect(unchanged.outcome).toBe("pass");
    expect(unchanged.base!.catch_rate).toEqual({ numerator: 2, denominator: 2, value: 1 });
    expect(unchanged.head!.false_alarm_rate).toEqual({ numerator: 0, denominator: 2, value: 0 });

    const ids = (from: number) => runner.specs.slice(from).map((s) => /spec for (\w+)/.exec(s.prompt)![1]);
    expect(ids(0)).toEqual(["1", "2", "3", "4", "1", "2", "3", "4"]);

    const broken = await compareCases(
      { ...d, prompt: async () => BROKEN_PROMPT, clock: new FakeClock(new Date("2026-11-08T13:00:00.000Z")) },
      { role: "review", basePrompt: prompts.review, changed: ["prompts/review.md"] },
    );
    expect(broken.outcome).toBe("fail");
    expect(broken.reason).toContain("catch_rate dropped by 1.000");
    expect(broken.head!.catch_rate).toEqual({ numerator: 0, denominator: 2, value: 0 });
    expect(runner.specs.slice(8).map((s) => s.system_prompt)).toEqual([...Array(4).fill(prompts.review), ...Array(4).fill(BROKEN_PROMPT)]);

    const text = formatCompare(broken);
    expect(text).toContain("golden compare (review): fail");
    expect(text).toContain("- base: catch_rate: 2/2 = 1.000; false_alarm_rate: 0/2 = 0.000");
    expect(text).toContain("- head: catch_rate: 0/2 = 0.000; false_alarm_rate: 0/2 = 0.000");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes each side's results file and one compare record under the results dir", async () => {
    const d = deps(fixtureRunner());
    await seedFixture(d);
    const r = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: null });
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
    const r = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: ["README.md", "prompts/triage.md"] });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("touches neither prompts/review.md nor the code");
    expect(runner.specs).toEqual([]);
    expect(formatCompare(r)).toContain("Comparison skipped:");
    expect(JSON.parse(await readFile(r.record_file, "utf8")).outcome).toBe("skipped");
  });

  it("skips with a reason when only cases under a role's golden folder changed", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);
    const r = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: ["src/worker/roles/review/golden/1/case.json"] });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("touches neither prompts/review.md nor the code");
    expect(runner.specs).toEqual([]);
  });

  it("skips with zero cases, and with no case tagged with the changed prompt", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    const none = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: null });
    expect(none.outcome).toBe("skipped");
    expect(none.reason).toContain("no golden cases tagged review.md in src/worker/roles/review/golden");

    await writeCase(casesDir(), "1", "should_flag", { prompts: ["implement.md"] });
    const untagged = await compareCases(
      { ...d, clock: new FakeClock(new Date("2026-11-08T13:00:00.000Z")) },
      { role: "review", basePrompt: prompts.review, changed: ["prompts/review.md"] },
    );
    expect(untagged.outcome).toBe("skipped");
    expect(runner.specs).toEqual([]);
  });

  it("replays only the cases tagged with the changed prompt", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await seedFixture(d);
    await writeCase(casesDir(), "5", "should_flag", { prompts: ["implement.md"] });
    await compareCases(d, { role: "review", basePrompt: prompts.review, changed: ["src/impl/runner/claude-code-runner.ts"] });
    expect(runner.specs.map((s) => /spec for (\w+)/.exec(s.prompt)![1])).not.toContain("5");
  });

  it("skips with an n/a rate on either side", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await writeCase(casesDir(), "1", "should_flag");
    const r = await compareCases(d, { role: "review", basePrompt: prompts.review, changed: null });
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
    // A case under a role's golden folder is not prompt code, though it sits under src/worker/.
    expect(affectedPrompts(["src/worker/roles/review/golden/1/instruction.md", "src/worker/roles/demo/golden/2/case.json"], ["review.md"])).toEqual([]);
    expect(affectedPrompts(["src/worker/roles/review.role.ts"], ["review.md"])).toEqual(["review.md"]);
  });

  it("parses its arguments", () => {
    expect(parseCompareArgs(["--base", "b.md"])).toEqual({ role: "review", base: "b.md", all: false });
    expect(parseCompareArgs(["--agent", "reviewer", "--base", "b.md", "--since", "main"])).toEqual({ role: "review", base: "b.md", since: "main", all: false });
    expect(() => parseCompareArgs([])).toThrow(GoldenError);
    expect(() => parseCompareArgs(["--base", "b.md", "--agent", "triage"])).toThrow(/only --agent reviewer/);
    expect(() => parseCompareArgs(["--base", "b.md", "--all", "--since", "main"])).toThrow(GoldenError);
  });

  it("refuses a malformed prompts tag before any agent runs", async () => {
    const runner = fixtureRunner();
    const d = deps(runner);
    await writeCase(casesDir(), "1", "should_flag", { prompts: "review.md" });
    await expect(compareCases(d, { role: "review", basePrompt: prompts.review, changed: null })).rejects.toThrow(/case 1: prompts must be/);
    expect(runner.specs).toEqual([]);
    expect(existsSync(join(d.resultsDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Eval on change (design 06-measurement, issue #493): the per-entity golden gate over runCases, on a SQLite store.

const GOOD_SKILL = "Write the failing test first, then change the code and the files the spec names.";
const BROKEN_SKILL = "BROKEN: change only the first file the spec names.";
const SKILL = "skill:tests-first";
const IMPLEMENT_CASE = "implement/643";

describe("golden gate (eval on change)", () => {
  /** The seeded implement case, copied from the repo with a seeded skill added to its `uses`. */
  async function seedImplementCase(rolesDir: string, uses: string[] = [SKILL]) {
    const dst = join(rolesDir, "implement", "golden", "643");
    await cp(join(REPO, "src", "worker", "roles", "implement", "golden", "643"), dst, { recursive: true });
    const meta = JSON.parse(await readFile(join(dst, "case.json"), "utf8")) as { uses: string[] };
    await writeFile(join(dst, "case.json"), JSON.stringify({ ...meta, uses: [...meta.uses, ...uses] }));
  }

  /**
   * The replay deps: the skill reaches the implement run with its prompt; the fixture agent changes both files the
   * case's diff changes, or only the first under the broken skill. Each run moves the clock, so results files differ.
   */
  function world(golden: GoldenGateDeps["golden"]) {
    const clock = new FakeClock(new Date("2026-11-18T12:00:00.000Z"));
    const sandbox = new FakeSandbox();
    const state = { skill: GOOD_SKILL };
    const runner = new FakeRunner({
      implement: (spec: AgentRunSpec) => {
        clock.advance(1000);
        sandbox.changedFiles = spec.system_prompt.includes("BROKEN") ? ["scripts/build.mjs"] : ["scripts/build.mjs", "tsconfig.migrations.json"];
        return { output: null };
      },
      review: (spec: AgentRunSpec) => {
        clock.advance(1000);
        return { output: spec.prompt.includes("// should_flag") ? REVIEW_BUG : REVIEW_PASS };
      },
    });
    const rd: GoldenRunDeps = {
      rolesDir: join(tmp, "src", "worker", "roles"),
      roles: new RoleCatalog([
        { file: "worker/roles/implement.role.ts", descriptor: implementRole },
        { file: "worker/roles/review.role.ts", descriptor: reviewRole },
      ]),
      prompt: async (file) => (file === "implement.md" ? `${prompts.implement}\n\n${state.skill}` : prompts.review),
      resultsDir: join(tmp, "state", "golden", "results"),
      sandbox,
      runner,
      scanner: cleanScanner,
      clock,
      config,
    };
    const comments: { key: string; body: string }[] = [];
    const gate = (store: GoldenGateDeps["store"], over: Partial<GoldenGateDeps> = {}): GoldenGateDeps => ({
      golden,
      rolesDir: rd.rolesDir,
      store,
      replay: (role, ids, n) => replayCases(rd, role, ids, n),
      comment: async (_it, key, body) => void comments.push({ key, body }),
      ...over,
    });
    return { state, runner, rd, comments, gate };
  }

  async function item(store: FactoryStore) {
    return (await store.createWorkItem(issue(1), system)).item;
  }

  it("blocks a seeded skill change that breaks the implement case on a human, naming the failing case", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { store } = await newStore();
    const w = world({ replays: 1, regression_margin: 0.05 });
    await seedImplementCase(w.rd.rolesDir);
    const it0 = await item(store);

    const first = await checkChange(w.gate(store), it0, [{ id: SKILL, content: GOOD_SKILL }]);
    expect(first).toMatchObject({ outcome: "pass", ran: [IMPLEMENT_CASE], skipped: [] });
    expect(await store.getGoldenFingerprint(SKILL)).toMatchObject({ verdict: "pass", pass_rate: 1, base_fingerprint: fingerprint(GOOD_SKILL), base_rate: 1 });

    w.state.skill = BROKEN_SKILL;
    const second = await checkChange(w.gate(store), (await store.getWorkItem(it0.id))!, [{ id: SKILL, content: BROKEN_SKILL }]);
    expect(second.outcome).toBe("regression");
    expect(w.runner.specs.map((s) => s.role)).toEqual(["implement", "implement"]);
    const blocked = (await store.getWorkItem(it0.id))!;
    expect([blocked.blocked_on, blocked.blocked_reason]).toEqual(["human", EVAL_REGRESSION]);
    expect(w.comments).toHaveLength(1);
    expect(w.comments[0]!.body).toContain(`\`${IMPLEMENT_CASE}\``);
    expect(w.comments[0]!.body).toContain(`\`${SKILL}\`: pass rate 0.000, down from 1.000`);
    const change = (await store.listStateChanges(it0.id)).at(-1)!;
    expect(change).toMatchObject({ reason: EVAL_REGRESSION, detail: { failing_cases: JSON.stringify([IMPLEMENT_CASE]) } });
    // The regression is the last verdict; the base stays the last passing run.
    expect(await store.getGoldenFingerprint(SKILL)).toMatchObject({ verdict: "regression", fingerprint: fingerprint(BROKEN_SKILL), failing_cases: [IMPLEMENT_CASE], base_fingerprint: fingerprint(GOOD_SKILL), base_rate: 1 });

    // Run twice: the item stays as it is, and no second comment is posted.
    await checkChange(w.gate(store), blocked, [{ id: SKILL, content: BROKEN_SKILL }]);
    expect((await store.getWorkItem(it0.id))!.version).toBe(blocked.version);
    expect(w.comments).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not re-run an entity whose content matches its last passing run, reading the fingerprint from the store", async () => {
    const { store } = await newStore();
    const w = world({ replays: 1, regression_margin: 0.05 });
    await seedImplementCase(w.rd.rolesDir);
    const it0 = await item(store);
    await checkChange(w.gate(store), it0, [{ id: SKILL, content: GOOD_SKILL }]);
    const calls = w.runner.specs.length;

    // A fresh gate (another worker) on the same store: zero runner calls for the unchanged entity.
    const again = await checkChange(w.gate(store), it0, [{ id: SKILL, content: GOOD_SKILL }]);
    expect(again).toEqual({ outcome: "pass", ran: [], skipped: [SKILL], verdicts: [] });
    expect(w.runner.specs.length).toBe(calls);
  });

  it("runs a case when any entity it uses changes, and once per change however many changed entities list it", async () => {
    const { store } = await newStore();
    const w = world({ replays: 1, regression_margin: 0.05 });
    await seedImplementCase(w.rd.rolesDir);
    await writeCase(casesDir(), "1", "should_flag", { uses: ["prompt:review.md"] });
    const it0 = await item(store);

    const both = await checkChange(w.gate(store), it0, [
      { id: "prompt:implement.md", content: "v1" }, { id: SKILL, content: GOOD_SKILL }, { id: "role:implement", content: "r1" }, { id: "skill:unused", content: "x" },
    ]);
    expect(both.ran).toEqual([IMPLEMENT_CASE]);
    expect(w.runner.specs.map((s) => s.role)).toEqual(["implement"]);
    expect(both.verdicts.map((v) => v.entity_id)).toEqual(["prompt:implement.md", SKILL, "role:implement"]);
    expect(await store.getGoldenFingerprint("skill:unused")).toBeNull();

    // One listed entity changes: its dependent case runs again; the review case runs only for the entity it uses.
    const one = await checkChange(w.gate(store), it0, [{ id: "prompt:implement.md", content: "v2" }, { id: SKILL, content: GOOD_SKILL }, { id: "prompt:review.md", content: "p1" }]);
    expect(one.ran).toEqual([IMPLEMENT_CASE, "review/1"]);
    expect(one.skipped).toEqual([SKILL]);
    expect(w.runner.specs.map((s) => s.role)).toEqual(["implement", "implement", "review"]);
  });

  it("replays each case golden.replays times and compares the pass rate with the base against the margin: exactly the margin passes", async () => {
    const { store } = await newStore();
    const w = world({ replays: 3, regression_margin: 0.05 });
    await seedImplementCase(w.rd.rolesDir);
    await checkChange(w.gate(store), await item(store), [{ id: SKILL, content: GOOD_SKILL }]);
    expect(w.runner.specs.map((s) => s.role)).toEqual(["implement", "implement", "implement"]);

    // A scripted LLM case: 20 replays per change, so each failed replay moves the pass rate by 0.05.
    const { store: s2 } = await newStore();
    const it2 = await item(s2);
    const asked: number[] = [];
    let failing = 0;
    const replay: GoldenGateDeps["replay"] = async (_role, ids, n) => {
      asked.push(n);
      return Array.from({ length: n }, (_, i) => ({ id: ids[0]!, passed: i >= failing }));
    };
    const scripted = world({ replays: 20, regression_margin: 0.05 });
    await seedImplementCase(scripted.rd.rolesDir);
    const step = async (content: string, fails: number) => {
      failing = fails;
      return checkChange(scripted.gate(s2, { replay }), (await s2.getWorkItem(it2.id))!, [{ id: SKILL, content }]);
    };
    expect((await step("a", 0)).verdicts[0]).toMatchObject({ verdict: "pass", pass_rate: 1, base_rate: 1 });
    // 1.00 → 0.95: exactly the margin, a pass, which becomes the base.
    expect((await step("b", 1)).verdicts[0]).toMatchObject({ verdict: "pass", pass_rate: 0.95, base_rate: 0.95 });
    // 0.95 → 0.85: more than the margin, a regression against the last passing run's rate.
    const r = await step("c", 3);
    expect(r.outcome).toBe("regression");
    expect(r.verdicts[0]).toMatchObject({ verdict: "regression", pass_rate: 0.85, base_rate: 0.95, failing_cases: [IMPLEMENT_CASE] });
    expect(asked).toEqual([20, 20, 20]);
    expect((await s2.getWorkItem(it2.id))!.blocked_reason).toBe(EVAL_REGRESSION);
  });

  it("with no golden block, runs no eval and blocks nothing", async () => {
    const { store } = await newStore();
    const w = world(goldenConfig({ repo: {} }));
    await seedImplementCase(w.rd.rolesDir);
    const it0 = await item(store);
    w.state.skill = BROKEN_SKILL;
    expect(await checkChange(w.gate(store), it0, [{ id: SKILL, content: BROKEN_SKILL }])).toEqual({ outcome: "off", ran: [], skipped: [], verdicts: [] });
    expect(w.runner.specs).toEqual([]);
    expect(w.comments).toEqual([]);
    expect((await store.getWorkItem(it0.id))!.version).toBe(it0.version);
    expect(await store.getGoldenFingerprint(SKILL)).toBeNull();
  });

  it("refuses a malformed uses list before any replay", async () => {
    const { store } = await newStore();
    const w = world({ replays: 1, regression_margin: 0.05 });
    await writeCase(casesDir(), "1", "should_flag", { uses: "prompt:review.md" });
    await expect(checkChange(w.gate(store), await item(store), [{ id: "prompt:review.md", content: "x" }])).rejects.toThrow(/case review\/1: uses must be a list of entity ids/);
    expect(w.runner.specs).toEqual([]);
  });
});
