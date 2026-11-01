import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_SCHEMA } from "../src/core/outputs.js";
import type { Actor, UserId, WorkItem, WorkItemPatch, WorkerId } from "../src/core/types.js";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import {
  type CaseResult,
  type GoldenRunDeps,
  GoldenError,
  REVIEW_HARNESS_TOOLS,
  addCase,
  buildGoldenRunDeps,
  computeRates,
  formatReport,
  parseAddArgs,
  parseRunArgs,
  readPrRecord,
  runCases,
} from "../src/golden.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { EgressChannel, EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth,
  FakeBroker,
  PROJECT as PROJECT_REF,
  FakeGitHubDiff,
  FakeRunner,
  FakeSandbox,
  FakeSource,
  MemoryStorage,
  alice,
  cleanScanner,
  config,
  issueRef,
  prompts,
  silent,
  triageSpec,
} from "./helpers/fakes.js";
import { TokenCredentials } from "../src/impl/github/token-credentials.js";

const PROJECT = PROJECT_REF.key;
const SYSTEM: Actor = { kind: "system", id: "system:test" };
const HUMAN: Actor = { kind: "user", id: "github:1" as UserId };
const TOKEN = `ghp_${"A".repeat(36)}`;
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sf-golden-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

/** A scanner that records every call and delegates to the real pattern scanner. */
class RecordingScanner implements EgressScanner {
  calls: { channel: EgressChannel; content: string }[] = [];
  async scan(channel: EgressChannel, content: string): Promise<ScanResult> {
    this.calls.push({ channel, content });
    return cleanScanner.scan(channel, content);
  }
}

type Outcome = "clean_merge" | "rejected" | "reverted" | "fixed_forward" | "held";

/** A factory item with PR `pr`, taken to `outcome` through the store's real transitions. */
async function seed(store: FactoryStore, pr: number, outcome: Outcome): Promise<WorkItem> {
  let { item } = await store.createWorkItem(
    { source: issueRef(pr), requester_id: "github:1" as UserId, project: PROJECT, problem: "p", resources: [] },
    SYSTEM,
  );
  const step = async (patch: WorkItemPatch, reason: string, actor: Actor = SYSTEM, detail?: Record<string, string | number | null>) => {
    const r = await store.transition({ id: item.id, expected_version: item.version, patch, actor, reason, ...(detail && { detail }) });
    if (!r.ok) throw new Error(r.reason);
    item = r.item;
  };
  await step(
    {
      problem: "Add a scope gate",
      done_criteria: ["CI fails outside allowed_paths"],
      desired_output: "a workflow",
      scope: "CI only",
      allowed_paths: [".github/"],
      tier: 2,
      stage: "REVIEW",
      pr_number: pr,
      blocked_on: "human",
      blocked_reason: "merge_pending",
    },
    "review_passed",
  );
  if (outcome === "held") return item;
  if (outcome === "rejected") {
    await step({ stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, "pr_closed_unmerged", HUMAN);
    return item;
  }
  await step({ stage: "CLOSED", close_reason: "completed", merge_sha: `sha${pr}`, blocked_on: "none", blocked_reason: null }, "pr_merged", HUMAN);
  if (outcome === "reverted") await step({}, "reverted", SYSTEM, { reverting_commit: "rc1", reverting_pr: 99 });
  if (outcome === "fixed_forward") await step({}, "fixed_forward", SYSTEM, { fix_work_item_id: "wi_fix" });
  return item;
}

async function addDeps(store: FactoryStore, diff = DIFF) {
  const github = new FakeGitHubDiff({ 7: diff, 8: diff, 9: diff });
  const scanner = new RecordingScanner();
  const casesDir = join(tmp, "golden", "cases");
  return { store, project: PROJECT_REF, github, scanner, casesDir };
}

describe("golden add", () => {
  it("writes diff.patch, spec.md and case.json for a reverted PR", async () => {
    const { store } = await newStore();
    const item = await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    const r = await addCase(deps, { pr: "7" });

    const dir = join(deps.casesDir, "7");
    expect(r.dir).toBe(dir);
    expect((await readdir(dir)).sort()).toEqual(["case.json", "diff.patch", "spec.md"]);
    expect(await readFile(join(dir, "diff.patch"), "utf8")).toBe(DIFF);

    const spec = await readFile(join(dir, "spec.md"), "utf8");
    expect(spec).toContain(`# Work item ${item.id}`);
    expect(spec).toContain("## Problem\n\nAdd a scope gate");
    expect(spec).toContain("## Done criteria\n- CI fails outside allowed_paths");
    expect(spec).toContain("## Allowed paths (do not change files outside these)\n- .github/");

    const c = JSON.parse(await readFile(join(dir, "case.json"), "utf8"));
    const changes = await store.listStateChanges(item.id);
    const merged = changes.find((s) => s.reason === "pr_merged")!;
    const reverted = changes.find((s) => s.reason === "reverted")!;
    expect(c).toEqual({
      id: "7",
      pr_number: 7,
      work_item_id: item.id,
      expect: "should_flag",
      outcome: "reverted",
      human_verdict: { reason: "pr_merged", actor_id: "github:1", record_id: merged.id },
      revert_reason: { reason: "reverted", record_id: reverted.id, detail: { reverting_commit: "rc1", reverting_pr: 99 } },
      source_record_ids: [merged.id, reverted.id],
    });
    expect(deps.github.calls).toEqual([7]);
  });

  it("records the human's close for a rejected PR, with no revert reason", async () => {
    const { store } = await newStore();
    await seed(store, 7, "rejected");
    const deps = await addDeps(store);
    await addCase(deps, { pr: "7" });
    const c = JSON.parse(await readFile(join(deps.casesDir, "7", "case.json"), "utf8"));
    expect(c.expect).toBe("should_flag");
    expect(c.outcome).toBe("rejected");
    expect(c.human_verdict).toMatchObject({ reason: "pr_closed_unmerged", actor_id: "github:1" });
    expect(c.revert_reason).toBeNull();
  });

  it("scans every file with channel commit before writing, and writes nothing on a finding", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store, `${DIFF}+const t = "${TOKEN}";\n`);

    const err = await addCase(deps, { pr: "7" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenError);
    expect((err as Error).message).toContain("github_token");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(existsSync(join(deps.casesDir, "7"))).toBe(false);
    expect(existsSync(deps.casesDir) ? await readdir(deps.casesDir) : []).toEqual([]);
    // Every file was scanned, all with channel commit.
    expect(deps.scanner.calls.map((c) => c.channel)).toEqual(["commit", "commit", "commit"]);
  });

  it("scans each of the three file contents", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    await addCase(deps, { pr: "7" });
    const dir = join(deps.casesDir, "7");
    const written = await Promise.all(["diff.patch", "spec.md", "case.json"].map((f) => readFile(join(dir, f), "utf8")));
    expect(deps.scanner.calls.map((c) => c.content).sort()).toEqual(written.sort());
  });

  it("refuses an existing case directory unless --force", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    const dir = join(deps.casesDir, "7");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "case.json"), "old");

    await expect(addCase(deps, { pr: "7" })).rejects.toThrow(/already exists.*--force/);
    expect(await readFile(join(dir, "case.json"), "utf8")).toBe("old");
    expect(deps.github.calls).toEqual([]);

    await addCase(deps, { pr: "7", force: true });
    expect(JSON.parse(await readFile(join(dir, "case.json"), "utf8")).outcome).toBe("reverted");
  });

  it("refuses an expect value other than should_flag and should_pass", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    await expect(addCase(deps, { pr: "7", expect: "maybe" })).rejects.toThrow(/expect must be should_flag or should_pass/);
    expect(existsSync(join(deps.casesDir, "7"))).toBe(false);
    expect(() => parseAddArgs(["7", "--expect", "flag"])).toThrow(/expect must be should_flag or should_pass/);
  });

  it("refuses a PR number that is not a positive integer, and a PR with no factory work item", async () => {
    const { store } = await newStore();
    const deps = await addDeps(store);
    await expect(addCase(deps, { pr: "../x" })).rejects.toThrow(/positive integer/);
    await expect(addCase(deps, { pr: "7" })).rejects.toThrow(/no factory work item/);
  });

  describe("expect against the PR record", () => {
    const cases: { outcome: Outcome; expect: "should_flag" | "should_pass" | undefined; ok: boolean; result?: string }[] = [
      { outcome: "rejected", expect: "should_pass", ok: false },
      { outcome: "reverted", expect: "should_pass", ok: false },
      { outcome: "fixed_forward", expect: "should_pass", ok: false },
      { outcome: "held", expect: "should_pass", ok: false },
      { outcome: "clean_merge", expect: "should_flag", ok: false },
      { outcome: "clean_merge", expect: undefined, ok: false },
      { outcome: "clean_merge", expect: "should_pass", ok: true, result: "should_pass" },
      { outcome: "rejected", expect: undefined, ok: true, result: "should_flag" },
      { outcome: "rejected", expect: "should_flag", ok: true, result: "should_flag" },
      { outcome: "reverted", expect: "should_flag", ok: true, result: "should_flag" },
      { outcome: "fixed_forward", expect: undefined, ok: true, result: "should_flag" },
      { outcome: "held", expect: "should_flag", ok: true, result: "should_flag" },
    ];
    for (const c of cases) {
      it(`${c.outcome} with ${c.expect ?? "no --expect"}: ${c.ok ? c.result : "refused"}`, async () => {
        const { store } = await newStore();
        await seed(store, 7, c.outcome);
        const deps = await addDeps(store);
        const run = addCase(deps, { pr: "7", ...(c.expect && { expect: c.expect }) });
        if (c.ok) {
          await run;
          const json = JSON.parse(await readFile(join(deps.casesDir, "7", "case.json"), "utf8"));
          expect(json.expect).toBe(c.result);
          expect(json.outcome).toBe(c.outcome);
        } else {
          await expect(run).rejects.toThrow(GoldenError);
          expect(existsSync(join(deps.casesDir, "7"))).toBe(false);
        }
      });
    }
  });

  it("readPrRecord reads the merge and the revert through the store APIs", async () => {
    const { store } = await newStore();
    const item = await seed(store, 8, "fixed_forward");
    const r = await readPrRecord(store, PROJECT, 8);
    expect(r?.item.id).toBe(item.id);
    expect(r?.record.outcome).toBe("fixed_forward");
    expect(r?.record.revert_reason).toMatchObject({ reason: "fixed_forward", detail: { fix_work_item_id: "wi_fix" } });
    expect(await readPrRecord(store, PROJECT, 1)).toBeNull();
  });

  it("parses golden add arguments", () => {
    expect(parseAddArgs(["7"])).toEqual({ pr: "7", force: false });
    expect(parseAddArgs(["7", "--force", "--expect", "should_pass"])).toEqual({ pr: "7", force: true, expect: "should_pass" });
    expect(() => parseAddArgs([])).toThrow(/usage/);
    expect(() => parseAddArgs(["7", "--bogus"])).toThrow(/unknown option/);
  });
});

describe("GitHubClient.pullDiff", () => {
  it("GETs the PR with the diff media type and returns the text", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(DIFF, { status: 200 });
    });
    const secrets: SecretStore = {
      async get() {
        return { reveal: () => "tkn" } as never;
      },
    } as unknown as SecretStore;
    const gh = new GitHubClient(new TokenCredentials(secrets), "https://gh.test");
    expect(await gh.pullDiff({ owner: "o", name: "r" }, 7)).toBe(DIFF);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gh.test/repos/o/r/pulls/7");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toBe("application/vnd.github.diff");
    expect(calls[0]!.init.body).toBeUndefined();
  });
});

const REVIEW_PASS = { verdict: "pass", tier: 2, findings: [], summary: "ok" };
const REVIEW_BUG = { verdict: "bug", tier: 2, findings: ["off by one in x.ts"], summary: "bug" };

async function writeCase(casesDir: string, id: string, expectValue: string, diff = `${DIFF}// case ${id}\n`) {
  const dir = join(casesDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "diff.patch"), diff);
  await writeFile(join(dir, "spec.md"), `# Work item wi_${id}\n\n## Problem\n\nspec for ${id}`);
  await writeFile(
    join(dir, "case.json"),
    JSON.stringify({ id, pr_number: Number(id), work_item_id: `wi_${id}`, expect: expectValue, outcome: "x", human_verdict: null, revert_reason: null, source_record_ids: [] }),
  );
}

function runDeps(runner: FakeRunner, over: Partial<GoldenRunDeps> = {}): GoldenRunDeps & { sandbox: FakeSandbox } {
  return {
    casesDir: join(tmp, "golden", "cases"),
    resultsDir: join(tmp, "state", "golden", "results"),
    sandbox: new FakeSandbox(),
    runner,
    scanner: new RecordingScanner(),
    clock: new FakeClock(new Date("2026-11-01T12:00:00.000Z")),
    config,
    reviewPrompt: prompts.review,
    ...over,
  } as GoldenRunDeps & { sandbox: FakeSandbox };
}

/** A runner whose review answer is chosen by the case id found in the prompt. */
function byCase(answers: Record<string, Partial<AgentRunResult>>) {
  return new FakeRunner({
    review: (spec: AgentRunSpec) => {
      const id = /spec for (\w+)/.exec(spec.prompt)![1]!;
      return answers[id] ?? {};
    },
  });
}

describe("golden run", () => {
  it("runs each case once through the runner like the worker's review, in a detached sandbox, with no GitHub call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runner = byCase({ "1": { output: REVIEW_BUG }, "2": { output: REVIEW_PASS } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    await writeCase(deps.casesDir, "2", "should_pass");

    await runCases(deps, { agent: "reviewer" });

    expect(runner.specs).toHaveLength(2);
    for (const [i, id] of ["1", "2"].entries()) {
      const s = runner.specs[i]!;
      expect(s.role).toBe("review");
      expect(s.system_prompt).toBe(prompts.review);
      expect(s.output_schema).toBe(REVIEW_SCHEMA);
      expect(s.tools.map((t) => t.name)).toEqual(REVIEW_HARNESS_TOOLS);
      expect(s.tool_grants).toEqual([]);
      expect(s.model_class).toBe("strong");
      expect(s.prompt).toContain(`spec for ${id}`);
      expect(s.prompt).toContain(`## Diff\n\n\`\`\`diff\n${DIFF}// case ${id}\n\n\`\`\``);
      expect(s.deny_paths).toEqual(config.deny_paths);
    }
    expect(deps.sandbox.created).toEqual([
      { repo: config.repo.path, branch: null, base_ref: config.repo.base_branch },
      { repo: config.repo.path, branch: null, base_ref: config.repo.base_branch },
    ]);
    expect(deps.sandbox.destroyed).toBe(2);
    expect(deps.sandbox.gitCalls.filter((c) => c.includes("push"))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the same harness tools as the worker's review run", async () => {
    const { store } = await newStore(new FakeClock());
    const clock = new FakeClock();
    const source = new FakeSource();
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: () => ({ output: REVIEW_PASS }),
    });
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    const step = async () => {
      await controller.tickIntake();
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
    };
    source.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "100", approver: alice });
    await step();
    const review = runner.specs.find((s) => s.role === "review")!;
    expect(REVIEW_HARNESS_TOOLS).toEqual(review.tools.map((t) => t.name));
    expect(review.output_schema).toBe(REVIEW_SCHEMA);
  });

  it("counts verdict bug as flagged and failed or invalid runs as errored, outside both rates", async () => {
    const runner = byCase({
      "1": { output: REVIEW_BUG },
      "2": { output: REVIEW_PASS },
      "3": { status: "failed", output: null },
      "4": { output: { verdict: "maybe" } },
      "5": { output: REVIEW_BUG },
      "6": { output: REVIEW_PASS },
      "7": { status: "timed_out", output: null },
    });
    const deps = runDeps(runner);
    for (const [id, e] of [["1", "should_flag"], ["2", "should_flag"], ["3", "should_flag"], ["4", "should_pass"], ["5", "should_pass"], ["6", "should_pass"], ["7", "should_pass"]] as const) {
      await writeCase(deps.casesDir, id, e);
    }
    const report = await runCases(deps, { agent: "reviewer" });

    expect(report.counts).toEqual({
      should_flag: { total: 3, completed: 2, flagged: 1, errored: 1 },
      should_pass: { total: 4, completed: 2, flagged: 1, errored: 2 },
    });
    expect(report.rates.catch_rate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.rates.false_alarm_rate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.cases.map((c) => [c.id, c.verdict])).toEqual([
      ["1", "bug"], ["2", "pass"], ["3", "errored"], ["4", "errored"], ["5", "bug"], ["6", "pass"], ["7", "errored"],
    ]);
    const text = formatReport(report);
    expect(text).toContain("catch_rate: 1/2 = 0.500");
    expect(text).toContain("false_alarm_rate: 1/2 = 0.500");
    expect(text).toContain("errored: 3 (should_flag 1, should_pass 2), excluded from both rates");
  });

  it("refuses an agent other than reviewer", async () => {
    const runner = byCase({});
    const deps = runDeps(runner);
    await expect(runCases(deps, { agent: "implementer" })).rejects.toThrow(/only --agent reviewer is supported/);
    expect(() => parseRunArgs(["--agent", "triage"])).toThrow(/only --agent reviewer is supported/);
    expect(() => parseRunArgs([])).toThrow(/only --agent reviewer is supported/);
    expect(parseRunArgs(["--agent", "reviewer"])).toEqual({ agent: "reviewer" });
    expect(runner.specs).toEqual([]);
  });

  it("writes results under the state dir, scanned as run_outcome, with only ids, verdicts, findings, rates and counts", async () => {
    const runner = byCase({ "1": { output: REVIEW_BUG }, "2": { output: REVIEW_PASS } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    await writeCase(deps.casesDir, "2", "should_pass");
    const report = await runCases(deps, { agent: "reviewer" });

    const files = await readdir(deps.resultsDir);
    expect(files).toEqual(["2026-11-01T12-00-00-000Z.json"]);
    expect(report.results_file).toBe(join(deps.resultsDir, files[0]!));
    const json = JSON.parse(await readFile(join(deps.resultsDir, files[0]!), "utf8"));
    expect(Object.keys(json).sort()).toEqual(["agent", "at", "cases", "counts", "rates"]);
    expect(json.cases).toEqual([
      { id: "1", expect: "should_flag", verdict: "bug", findings: ["off by one in x.ts"] },
      { id: "2", expect: "should_pass", verdict: "pass", findings: [] },
    ]);
    const scanner = deps.scanner as RecordingScanner;
    expect(scanner.calls.filter((c) => c.channel === "run_outcome").map((c) => c.content)).toEqual([
      await readFile(join(deps.resultsDir, files[0]!), "utf8"),
    ]);
  });

  it("writes no results file when the scan finds something", async () => {
    const runner = byCase({ "1": { output: { ...REVIEW_BUG, findings: [`leaked ${TOKEN}`] } } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    const err = await runCases(deps, { agent: "reviewer" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenError);
    expect((err as Error).message).toContain("github_token");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(existsSync(deps.resultsDir) ? await readdir(deps.resultsDir) : []).toEqual([]);
  });

  it("refuses to start when a case.json has an invalid expect, before any agent runs", async () => {
    const runner = byCase({ "1": { output: REVIEW_BUG } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    await writeCase(deps.casesDir, "2", "bogus");
    await expect(runCases(deps, { agent: "reviewer" })).rejects.toThrow(/case 2: expect must be should_flag or should_pass/);
    expect(runner.specs).toEqual([]);
  });

  it("builds its parts without opening the store or building a broker", async () => {
    const opened: string[] = [];
    const sandbox = new FakeSandbox();
    const runner = byCase({});
    const plugins = {
      clock: async () => new FakeClock(),
      secrets: async () => ({}) as SecretStore,
      scanner: async () => cleanScanner,
      sandbox: async () => sandbox,
      runner: async () => runner,
      store: async () => {
        opened.push("store");
        throw new Error("store opened");
      },
      broker: async () => {
        opened.push("broker");
        throw new Error("broker built");
      },
    };
    const parts = await buildGoldenRunDeps(plugins, {
      root: tmp,
      stateDir: join(tmp, "state"),
      config,
      prompts,
    });
    expect(opened).toEqual([]);
    expect(parts.casesDir).toBe(join(tmp, "golden", "cases"));
    expect(parts.resultsDir).toBe(join(tmp, "state", "golden", "results"));
    expect(parts.runner).toBe(runner);
    expect(parts.sandbox).toBe(sandbox);
    expect(parts.reviewPrompt).toBe(prompts.review);
  });

  it("an empty case set reports n/a rates and still writes a results file", async () => {
    const deps = runDeps(byCase({}));
    const report = await runCases(deps, { agent: "reviewer" });
    expect(formatReport(report)).toContain("catch_rate: n/a (0/0)");
    expect(formatReport(report)).toContain("false_alarm_rate: n/a (0/0)");
    expect(await readdir(deps.resultsDir)).toHaveLength(1);
  });
});

describe("rates", () => {
  const r = (expectValue: "should_flag" | "should_pass", verdict: CaseResult["verdict"]): CaseResult => ({
    id: Math.random().toString(36).slice(2),
    expect: expectValue,
    verdict,
    findings: [],
  });

  it("mixed", () => {
    const rates = computeRates([r("should_flag", "bug"), r("should_flag", "pass"), r("should_flag", "bug"), r("should_pass", "pass"), r("should_pass", "bug"), r("should_pass", "pass"), r("should_pass", "pass")]);
    expect(rates.rates.catch_rate).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(rates.rates.false_alarm_rate).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
  });

  it("all flagged", () => {
    const rates = computeRates([r("should_flag", "bug"), r("should_flag", "bug"), r("should_pass", "bug")]);
    expect(rates.rates.catch_rate).toEqual({ numerator: 2, denominator: 2, value: 1 });
    expect(rates.rates.false_alarm_rate).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it("none flagged", () => {
    const rates = computeRates([r("should_flag", "pass"), r("should_pass", "pass"), r("should_pass", "pass")]);
    expect(rates.rates.catch_rate).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(rates.rates.false_alarm_rate).toEqual({ numerator: 0, denominator: 2, value: 0 });
  });

  it("empty class: a zero denominator is n/a, not NaN", () => {
    const only = computeRates([r("should_flag", "bug"), r("should_pass", "errored")]);
    expect(only.rates.catch_rate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(only.rates.false_alarm_rate).toEqual({ numerator: 0, denominator: 0, value: null });
    const text = formatReport({ ...only, cases: [], results_file: "x" });
    expect(text).toContain("catch_rate: 1/1 = 1.000");
    expect(text).toContain("false_alarm_rate: n/a (0/0)");
    expect(text).not.toContain("NaN");
  });
});
