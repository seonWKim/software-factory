import { DEFAULT_MODEL_BY, parseModelBy } from "../src/core/model-choice.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_SCHEMA } from "../src/core/outputs.js";
import type { Actor, UserId, WorkItem, WorkItemPatch, WorkerId } from "../src/core/types.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import {
  type CaseResult,
  type GoldenRunDeps,
  GoldenError,
  addCase,
  buildGoldenRunDeps,
  compareCases,
  computeRates,
  formatReport,
  parseAddArgs,
  parseRunArgs,
  readPrRecord,
  replayPrompt,
  runCases,
} from "../src/golden.js";
import { RoleCatalog, rolesShortOfGolden } from "../src/runtime/index.js";
import { defineRole } from "../src/shared/role.js";
import reviewRole from "../src/worker/roles/review.role.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { EgressChannel, EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { newStore } from "./helpers/store.js";
import {
  FakeForge, FakeAuth,
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
import { REPO } from "./architecture/lib.js";

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
      change_ref: String(pr),
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
  const rolesDir = join(tmp, "src", "worker", "roles");
  return { store, project: PROJECT_REF, github, scanner, rolesDir, casesDir: join(rolesDir, "review", "golden") };
}

describe("golden add", () => {
  it("writes instruction.md, environment/diff.patch and case.json for a reverted PR into the review folder", async () => {
    const { store } = await newStore();
    const item = await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    const r = await addCase(deps, { role: "review", pr: "7" });

    const dir = join(deps.casesDir, "7");
    expect(r.dir).toBe(join(tmp, "src", "worker", "roles", "review", "golden", "7"));
    expect(r.dir).toBe(dir);
    expect((await readdir(dir)).sort()).toEqual(["case.json", "environment", "instruction.md"]);
    expect(await readFile(join(dir, "environment", "diff.patch"), "utf8")).toBe(DIFF);

    const spec = await readFile(join(dir, "instruction.md"), "utf8");
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
    await addCase(deps, { role: "review", pr: "7" });
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

    const err = await addCase(deps, { role: "review", pr: "7" }).catch((e: unknown) => e);
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
    await addCase(deps, { role: "review", pr: "7" });
    const dir = join(deps.casesDir, "7");
    const written = await Promise.all([join("environment", "diff.patch"), "instruction.md", "case.json"].map((f) => readFile(join(dir, f), "utf8")));
    expect(deps.scanner.calls.map((c) => c.content).sort()).toEqual(written.sort());
  });

  it("refuses an existing case directory unless --force", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    const dir = join(deps.casesDir, "7");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "case.json"), "old");

    await expect(addCase(deps, { role: "review", pr: "7" })).rejects.toThrow(/already exists.*--force/);
    expect(await readFile(join(dir, "case.json"), "utf8")).toBe("old");
    expect(deps.github.calls).toEqual([]);

    await addCase(deps, { role: "review", pr: "7", force: true });
    expect(JSON.parse(await readFile(join(dir, "case.json"), "utf8")).outcome).toBe("reverted");
  });

  it("refuses an expect value other than should_flag and should_pass", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    await expect(addCase(deps, { role: "review", pr: "7", expect: "maybe" })).rejects.toThrow(/expect must be should_flag or should_pass/);
    expect(existsSync(join(deps.casesDir, "7"))).toBe(false);
    expect(() => parseAddArgs(["7", "--expect", "flag"])).toThrow(/expect must be should_flag or should_pass/);
  });

  it("refuses a PR number that is not a positive integer, and a PR with no factory work item", async () => {
    const { store } = await newStore();
    const deps = await addDeps(store);
    await expect(addCase(deps, { role: "review", pr: "../x" })).rejects.toThrow(/positive integer/);
    await expect(addCase(deps, { role: "review", pr: "7" })).rejects.toThrow(/no factory work item/);
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
        const run = addCase(deps, { role: "review", pr: "7", ...(c.expect && { expect: c.expect }) });
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

  it("writes into the --role folder", async () => {
    const { store } = await newStore();
    await seed(store, 7, "reverted");
    const deps = await addDeps(store);
    const r = await addCase(deps, { ...parseAddArgs(["7", "--role", "triage"]) });
    expect(r.dir).toBe(join(deps.rolesDir, "triage", "golden", "7"));
    expect((await readdir(r.dir)).sort()).toEqual(["case.json", "environment", "instruction.md"]);
    expect(existsSync(deps.casesDir)).toBe(false);
    await expect(addCase(deps, { role: "../x", pr: "7" })).rejects.toThrow(/kebab-case role name/);
  });

  it("parses golden add arguments; no --role means review", () => {
    expect(parseAddArgs(["7"])).toEqual({ pr: "7", role: "review", force: false });
    expect(parseAddArgs(["7", "--role", "triage"])).toEqual({ pr: "7", role: "triage", force: false });
    expect(parseAddArgs(["7", "--force", "--expect", "should_pass"])).toEqual({ pr: "7", role: "review", force: true, expect: "should_pass" });
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
  await mkdir(join(dir, "environment"), { recursive: true });
  await writeFile(join(dir, "environment", "diff.patch"), diff);
  await writeFile(join(dir, "instruction.md"), `# Work item wi_${id}\n\n## Problem\n\nspec for ${id}`);
  await writeFile(
    join(dir, "case.json"),
    JSON.stringify({ id, pr_number: Number(id), work_item_id: `wi_${id}`, expect: expectValue, outcome: "x", human_verdict: null, revert_reason: null, source_record_ids: [] }),
  );
}

const ROLES = new RoleCatalog([{ file: "worker/roles/review.role.ts", descriptor: reviewRole }]);

function runDeps(runner: FakeRunner, over: Partial<GoldenRunDeps> = {}): GoldenRunDeps & { sandbox: FakeSandbox; casesDir: string } {
  const rolesDir = join(tmp, "src", "worker", "roles");
  return {
    rolesDir,
    casesDir: join(rolesDir, "review", "golden"),
    roles: ROLES,
    prompt: async (file: string) => (file === "review.md" ? prompts.review : `prompt ${file}`),
    resultsDir: join(tmp, "state", "golden", "results"),
    sandbox: new FakeSandbox(),
    runner,
    scanner: new RecordingScanner(),
    clock: new FakeClock(new Date("2026-11-01T12:00:00.000Z")),
    config,
    ...over,
  } as GoldenRunDeps & { sandbox: FakeSandbox; casesDir: string };
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

    await runCases(deps, { role: "review" });

    expect(runner.specs).toHaveLength(2);
    for (const [i, id] of ["1", "2"].entries()) {
      const s = runner.specs[i]!;
      expect(s.role).toBe("review");
      expect(s.system_prompt).toBe(prompts.review);
      expect(s.output_schema).toBe(REVIEW_SCHEMA);
      expect(s.tools.map((t) => t.name)).toEqual(reviewRole.tools);
      expect(s.tool_grants).toEqual([]);
      // The review run's class from the default model_by table (design §4).
      expect(s.model_class).toBe("standard");
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

  it("uses the review role's tools, the same as the worker's review run", async () => {
    const { store } = await newStore(new FakeClock());
    const clock = new FakeClock();
    const source = new FakeSource();
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: () => ({ output: REVIEW_PASS }),
    });
    const controller = new ControllerRole({ store, source, forge: new FakeForge(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
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
    expect(reviewRole.tools).toEqual(review.tools.map((t) => t.name));
    expect(review.output_schema).toBe(REVIEW_SCHEMA);
    // Same model class as the golden replay (default table: standard).
    const replay = byCase({ "1": { output: REVIEW_PASS } });
    const deps = runDeps(replay);
    await writeCase(deps.casesDir, "1", "should_pass");
    await runCases(deps, { role: "review" });
    expect(replay.specs[0]!.model_class).toBe(review.model_class);
    expect(review.model_class).toBe("standard");
  });

  it("uses the review class of the configured model_by table", async () => {
    const runner = byCase({ "1": { output: REVIEW_PASS } });
    const deps = runDeps(runner, { model_by: parseModelBy({ ...DEFAULT_MODEL_BY, review: "strong" }) });
    await writeCase(deps.casesDir, "1", "should_pass");
    await runCases(deps, { role: "review" });
    expect(runner.specs[0]!.model_class).toBe("strong");
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
    const report = await runCases(deps, { role: "review" });

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
    expect(text).toContain("errored: 3 (should_flag 1, should_pass 2), excluded from every rate");
    // Pass rate: completed cases whose verdict matches expect (1 caught, 1 clean pass) over completed (4).
    expect(report.rates.pass_rate).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(text).toContain("pass_rate: 2/4 = 0.500");
  });

  it("takes role/<name>, no --agent, and refuses a role with no descriptor or a null prompt", async () => {
    const runner = byCase({});
    expect(parseRunArgs(["role/review"])).toEqual({ role: "review" });
    for (const bad of [["--agent", "reviewer"], [], ["review"], ["role/review", "x"]]) expect(() => parseRunArgs(bad)).toThrow(/usage: factory golden run role\/<name>/);
    expect(() => parseRunArgs(["role/../x"])).toThrow(/kebab-case/);
    await expect(runCases(runDeps(runner), { role: "nope" })).rejects.toThrow(/role nope has no descriptor/);
    const silentRole = defineRole({ ...reviewRole, name: "silent", prompt: null });
    const roles = new RoleCatalog([{ file: "worker/roles/silent.role.ts", descriptor: silentRole }]);
    await writeCase(join(tmp, "src", "worker", "roles", "silent", "golden"), "1", "should_pass");
    await expect(runCases(runDeps(runner, { roles }), { role: "silent" })).rejects.toThrow(/calls no model/);
    expect(runner.specs).toEqual([]);
  });

  it("writes results under the state dir, scanned as run_outcome, with ids, verdicts, findings, tokens, wall time, rates and counts", async () => {
    const runner = byCase({ "1": { output: REVIEW_BUG }, "2": { output: REVIEW_PASS } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    await writeCase(deps.casesDir, "2", "should_pass");
    const report = await runCases(deps, { role: "review" });

    const files = await readdir(deps.resultsDir);
    expect(files).toEqual(["2026-11-01T12-00-00-000Z.json"]);
    expect(report.results_file).toBe(join(deps.resultsDir, files[0]!));
    const json = JSON.parse(await readFile(join(deps.resultsDir, files[0]!), "utf8"));
    expect(Object.keys(json).sort()).toEqual(["at", "cases", "counts", "rates", "role", "totals"]);
    expect(json.role).toBe("review");
    expect(json.cases).toEqual([
      { id: "1", expect: "should_flag", verdict: "bug", findings: ["off by one in x.ts"], input_tokens: 10, output_tokens: 5, wall_ms: 0 },
      { id: "2", expect: "should_pass", verdict: "pass", findings: [], input_tokens: 10, output_tokens: 5, wall_ms: 0 },
    ]);
    expect(json.totals).toEqual({ input_tokens: 20, output_tokens: 10, wall_ms: 0 });
    const scanner = deps.scanner as RecordingScanner;
    expect(scanner.calls.filter((c) => c.channel === "run_outcome").map((c) => c.content)).toEqual([
      await readFile(join(deps.resultsDir, files[0]!), "utf8"),
    ]);
  });

  it("writes no results file when the scan finds something", async () => {
    const runner = byCase({ "1": { output: { ...REVIEW_BUG, findings: [`leaked ${TOKEN}`] } } });
    const deps = runDeps(runner);
    await writeCase(deps.casesDir, "1", "should_flag");
    const err = await runCases(deps, { role: "review" }).catch((e: unknown) => e);
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
    await expect(runCases(deps, { role: "review" })).rejects.toThrow(/case 2: expect must be should_flag or should_pass/);
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
    expect(parts.rolesDir).toBe(join(tmp, "src", "worker", "roles"));
    expect(parts.roles.get("review")?.prompt).toBe("review.md");
    expect(parts.resultsDir).toBe(join(tmp, "state", "golden", "results"));
    expect(parts.runner).toBe(runner);
    expect(parts.sandbox).toBe(sandbox);
    expect(await parts.prompt("review.md")).toBe(prompts.review);
  });

  it("an empty case set reports n/a rates and still writes a results file", async () => {
    const deps = runDeps(byCase({}));
    const report = await runCases(deps, { role: "review" });
    expect(formatReport(report)).toContain("catch_rate: n/a (0/0)");
    expect(formatReport(report)).toContain("false_alarm_rate: n/a (0/0)");
    expect(await readdir(deps.resultsDir)).toHaveLength(1);
  });
});

/** sha256 of each case's replay prompt, built from its spec.md and diff.patch before they moved to the review role folder. */
const PRE_MOVE_PROMPT_SHA256: Record<string, string> = {
  "399": "9cab6e2536f1095ddab4e19bc70a75206829eb3de0696d1f7081957b77782e79",
  "408": "bab6f8b233f5c7128ddb50fc393f3e2dd6c3b92bde2ccdcef3851d3ade276817",
  "409": "377ffd4a10154bd119a2e3d0cb3b121424d484485b9b0d6929b5f2c83674f948",
  "418": "a31fffd418bd10c6744ae93b1219960e693bc8dcdb18d8bba01d2e34eeb88d69",
  "420": "b3210e6138db72c0ad76ff4029a2f186159144d13cdcf2737966635ec873db25",
  "426": "b358cfcd1585a433d28780cb416c1a3d272bbd6d3a94f5d53c8f79983699a4a0",
  "540": "1657a02e5df725fcdad2c8d96bbeba8c4ce34b581df09014f44ef2bc71c6880c",
  "633": "4b9fc1ca8e53dcfc7497c70f0f33097043ba996f228bedf329ef36e2327317f6",
  "639": "96865658f248eca2a587f25784b18eea4ba486276a39c60523f3be6ca5bc3602",
  "649": "ce7d77149e362c8a39748e22b47966b746b43541500454ab408023b6e6248f9c",
  "672": "83379d69d205c04c9db50248de6cc12b35f39a5004aacb00f6a93e3c7ac23702",
  "681": "ecd0d7f0b2ad11bad04b931329f8e3cbb402e178866a98e6a024a55e3f621def",
  "683": "b8ff3371f435cef89746c94dd226cf368971bc9a2caad6dc04e57ad4e4190eef",
  "685": "812e71bb0d1424756ce304189fbb257161afe4c5e46b54ade069080bb564846d",
  "687": "5a7d9d00fa059ed6d8d30bb649b2bd4dfb46743f547e1b71a3fe4111d3fadcad",
};

describe("cases in role folders", () => {
  it("replays each moved review case with the same prompt it had before the move", async () => {
    const runner = new FakeRunner({ review: () => ({ output: REVIEW_PASS }) });
    const report = await runCases(runDeps(runner, { rolesDir: join(REPO, "src", "worker", "roles") }), { role: "review" });
    const ids = report.cases.map((c) => c.id);
    for (const [id, sha] of Object.entries(PRE_MOVE_PROMPT_SHA256)) {
      expect(ids, id).toContain(id);
      const i = ids.indexOf(id);
      expect(createHash("sha256").update(runner.specs[i]!.prompt).digest("hex"), id).toBe(sha);
      const dir = join(REPO, "src", "worker", "roles", "review", "golden", id);
      const pr = replayPrompt({ spec: await readFile(join(dir, "instruction.md"), "utf8"), diff: await readFile(join(dir, "environment", "diff.patch"), "utf8") });
      expect(createHash("sha256").update(pr).digest("hex"), id).toBe(sha);
    }
  });

  it("finds a new role's cases in run, compare and the minimum check, from its folder alone", async () => {
    const demo = defineRole({ ...reviewRole, name: "demo", prompt: "demo.md", golden: { min_cases: 2 } });
    const roles = new RoleCatalog([
      { file: "worker/roles/review.role.ts", descriptor: reviewRole },
      { file: "worker/roles/demo.role.ts", descriptor: demo },
    ]);
    const runner = new FakeRunner({ demo: () => ({ output: REVIEW_BUG }) } as never);
    const deps = runDeps(runner, { roles });
    const demoCases = join(deps.rolesDir, "demo", "golden");
    await writeCase(demoCases, "1", "should_flag");

    const report = await runCases(deps, { role: "demo" });
    expect(report.cases.map((c) => [c.id, c.verdict])).toEqual([["1", "bug"]]);
    expect(runner.specs[0]!.system_prompt).toBe("prompt demo.md");
    expect(runner.specs[0]!.role).toBe("demo");

    const compare = await compareCases(
      { ...deps, clock: new FakeClock(new Date("2026-11-01T13:00:00.000Z")) },
      { role: "demo", basePrompt: "old demo prompt", changed: ["prompts/demo.md"] },
    );
    expect(compare.prompts).toEqual(["demo.md"]);
    expect(runner.specs.slice(1).map((s) => s.system_prompt)).toEqual(["old demo prompt", "prompt demo.md"]);

    expect(rolesShortOfGolden(roles, deps.rolesDir)).toEqual([
      { role: "demo", cases: 1, min: 2 },
      { role: "review", cases: 0, min: 1 },
    ]);
    await writeCase(demoCases, "2", "should_pass");
    expect(rolesShortOfGolden(roles, deps.rolesDir).map((r) => r.role)).not.toContain("demo");
  });

  it("measures each case's wall time with the clock", async () => {
    const clock = new FakeClock(new Date("2026-11-01T12:00:00.000Z"));
    const runner = new FakeRunner({
      review: () => {
        clock.advance(1500);
        return { output: REVIEW_PASS, usage: { input_tokens: 120, output_tokens: 30, cost_usd: null } };
      },
    });
    const deps = runDeps(runner, { clock });
    await writeCase(deps.casesDir, "1", "should_pass");
    const report = await runCases(deps, { role: "review" });
    expect(report.cases[0]).toMatchObject({ input_tokens: 120, output_tokens: 30, wall_ms: 1500 });
    expect(formatReport(report)).toContain("case 1 (should_pass): pass, match; input_tokens 120, output_tokens 30, wall_ms 1500");
    expect(formatReport(report)).toContain("total (review, 1 cases): input_tokens 120, output_tokens 30, wall_ms 1500");
  });
});

describe("rates", () => {
  const r = (expectValue: "should_flag" | "should_pass", verdict: CaseResult["verdict"]): CaseResult => ({
    id: Math.random().toString(36).slice(2),
    expect: expectValue,
    verdict,
    findings: [],
    input_tokens: 0,
    output_tokens: 0,
    wall_ms: 0,
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
    const text = formatReport({ ...only, role: "review", cases: [], totals: { input_tokens: 0, output_tokens: 0, wall_ms: 0 }, results_file: "x" });
    expect(text).toContain("catch_rate: 1/1 = 1.000");
    expect(text).toContain("false_alarm_rate: n/a (0/0)");
    expect(text).not.toContain("NaN");
  });
});
