import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { AUTO_GRANT } from "../src/controller/units/run-results/auto-grant.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FAKE_GITHUB_TOOLS } from "./helpers/fakes/broker.js";
import { FakeAuth, FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, recordingLog, runComments } from "./helpers/fakes/config.js";
import { git, gitTemplate } from "./helpers/git-fixture.js";
import { newStore } from "./helpers/store.js";

// The checks grant (design 04-pre-push-gates, 2026-11-25): a checks_failed run whose every failing test file is
// outside allowed_paths and quotes text the branch diff removed gets those files once (auto_grant_test_paths), and
// the run after the grant starts a new step, so the failure is not counted toward repeated_failure.

const OLD = "Old label text";
const TEST = "tests/label.test.ts";

function commitFile(repo: string, path: string, content: string, msg: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
}

/** Pushes to the local bare remote like the real broker; records every other call. */
class GitPushBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: Record<string, unknown> }[] = [];
  listTools(): ToolDescriptor[] {
    return [];
  }
  allTools(): ToolDescriptor[] {
    return [...FAKE_GITHUB_TOOLS];
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const a = args as Record<string, unknown>;
    if (name === "forge.preflight") return { ok: true, content: {} };
    if (name === STORE_BRANCH) {
      git(String(a.workdir), "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: { sha: git(String(a.workdir), "rev-parse", "HEAD").trim(), forge: true } };
    }
    this.calls.push({ ctx, name, args: a });
    return { ok: true, content: {} };
  }
}

/** The label test: fails while the test still asserts OLD and src/label.txt no longer has it. */
const LABEL = ["sh", "-c", `if grep -q '${OLD}' ${TEST} && ! grep -q '${OLD}' src/label.txt; then echo ' FAIL  ${TEST} > shows the label'; exit 1; fi`, "label-tests"];
/** A lint check that fails while src/label.txt lacks OLD, naming no test file. */
const LINT = ["sh", "-c", `if ! grep -q '${OLD}' src/label.txt; then echo 'src/label.txt:1:1 error label-changed'; exit 1; fi`, "lint"];

const repos = gitTemplate((root) => {
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  commitFile(dev, "src/label.txt", `title: ${OLD}\n`, "add the label");
  commitFile(dev, TEST, `expect(label()).toBe("${OLD}");\n`, "add the label test");
  git(dev, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, join(root, "repo"));
});

type Step = (workdir: string, n: number) => Partial<AgentRunResult> | void;

/** An item whose implementer changes the label (removing OLD) unless `implement` says otherwise; the fix step changes nothing. */
async function setup(opts: { checks?: string[][]; allowed?: string[]; test?: string; implement?: Step; repeated?: boolean; max_attempts?: number } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const root = repos.copy();
  const repo = join(root, "repo");
  if (opts.test !== undefined) {
    commitFile(repo, TEST, opts.test, "base: the label test");
    git(repo, "push", "--quiet", "origin", "HEAD:main");
  }
  const cfg: FactoryConfig = {
    ...config, repo: { ...config.repo, path: repo, check_commands: opts.checks ?? [LABEL] },
    settings: { ...config.settings, defaults: { ...config.settings.defaults, max_attempts: opts.max_attempts ?? 3 } },
  };
  const spec = {
    in_short: "AS-IS: a.\nTO-BE: b.", problem: "Change the label", done_criteria: ["the label changes"],
    done_checks: [{ line: "the label changes", manual: true, reason: "a person reads it" }],
    desired_output: "a new label", scope: "src only", allowed_paths: opts.allowed ?? ["src/"], files_to_change: ["src/label.txt"],
    tier: 2, tier_reason: "small", estimated_lines: 10, estimated_files: 1,
  };
  let n = 0;
  const done = { output: { summary: "changed the label", next_steps: "none" } };
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s: AgentRunSpec) => {
      if (s.prompt.includes("## Checks failed before push")) return done;
      n++;
      const r = opts.implement?.(s.sandbox.workdir, n);
      if (r) return r;
      commitFile(s.sandbox.workdir, "src/label.txt", `title: New label (${n})\n`, `change the label (${n})`);
      return done;
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const source = new FakeSource();
  const broker = new GitPushBroker();
  const log = recordingLog();
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const controller = new ControllerRole({
    store, source, forge: new FakeForge(null, broker.calls), auth: new FakeAuth(), clock, config: cfg, log, scanner: cleanScanner,
    settings: new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store }),
    ...(opts.repeated === false ? { repeated_failure_rule: false } : {}),
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new NoOpSandbox(join(repo, ".worktrees")), runner, broker, storage: new MemoryStorage(), clock, config: cfg,
    prompts: { triage: "T", implement: "I", review: "R", resolve: "S" }, log, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(7);
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  const run = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "700", approver: alice });
    await step();
    return item();
  };
  const implementRuns = async () => (await store.listRuns((await item()).id)).filter((r) => r.kind === "implement");
  const changes = async () => store.listStateChanges((await item()).id);
  const grants = async () => (await changes()).filter((c) => c.reason === "retry_requested" && c.detail?.[AUTO_GRANT] === true);
  const comments = async (key: string) => (await runComments(store, (await item()).id)).filter((c) => c.marker.includes(`factory:${key}:`));
  const codes = async () => (await implementRuns()).map((r) => (r.outcome?.status === "failed" ? r.outcome.error_code : r.status));
  const setOff = (project: string) => store.setSettingOverride({ key: "auto_grant_test_paths", project, value: "false", actor: "local:owner" });
  const setOn = (project: string) => store.setSettingOverride({ key: "auto_grant_test_paths", project, value: "true", actor: "local:owner" });
  return { store, clock, cfg, step, run, item, implementRuns, changes, grants, comments, codes, setOff, setOn };
}

const grantTestsOf = (outcome: unknown) => (outcome as { grant_tests?: unknown }).grant_tests;

// Real git clone/push work per test, so 60 s.
describe("checks grant on checks_failed", { timeout: 60_000 }, () => {
  it("grants the failing test files once: they join allowed_paths and the item runs again", async () => {
    // Run 1 removes OLD; run 2 (with the test allowed) updates the test too, so its checks pass.
    const f = await setup({
      implement: (wd, n) => {
        if (n === 2) commitFile(wd, TEST, `expect(label()).toBe("New label (2)");\n`, "follow the label in its test");
      },
    });
    await f.run();
    const runs = await f.implementRuns();
    expect(runs[0]!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(grantTestsOf(runs[0]!.outcome)).toEqual([{ file: TEST, quotes: [OLD] }]);
    const it1 = await f.item();
    expect(it1.allowed_paths).toEqual(["src/", TEST]);
    expect(await f.codes()).toEqual(["checks_failed", "succeeded"]);
    expect(it1).toMatchObject({ stage: "REVIEW" });
    // The granted run starts a new step: a new idempotency key, not the failed run's retry key.
    expect(runs[1]!.idempotency_key).not.toBe(runs[0]!.idempotency_key);
  });

  it("posts one comment keyed on the run naming the files and the removed text, and stores one retry_requested with auto_grant and the run id", async () => {
    const f = await setup({ implement: (wd, n) => (n === 2 ? (commitFile(wd, TEST, "expect(1).toBe(1);\n", "follow"), undefined) : undefined) });
    await f.run();
    const [first] = await f.implementRuns();
    const grants = await f.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ actor: { kind: "system" }, detail: { run_id: first!.id, [AUTO_GRANT]: true, added_paths: JSON.stringify([TEST]) } });
    const posted = await f.comments("auto-grant");
    expect(posted.map((c) => c.marker)).toEqual([`<!-- factory:auto-grant:${first!.id} -->`]);
    expect(posted[0]!.body).toContain(`\`${TEST}\``);
    expect(posted[0]!.body).toContain(`"${OLD}"`);
    expect(posted[0]!.body).toContain("label-tests");
  });

  it("the granted run is not counted toward repeated_failure: the next run's same failure is a first one", async () => {
    // Run 2 changes the label again but leaves the test: the same checks_failed, now with the test covered.
    const f = await setup();
    await f.run();
    expect(await f.grants()).toHaveLength(1);
    expect(await f.codes()).toEqual(["checks_failed", "checks_failed", "queued"]);
    const it1 = await f.item();
    expect(it1.blocked_reason).not.toBe("repeated_failure");
    expect((await f.changes()).at(-1)).toMatchObject({ reason: "run_retry_scheduled" });
    // Without the grant, the next same failure in that step is a repeat.
    f.clock.advance(f.cfg.retry_max_ms);
    await f.step();
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "repeated_failure" });
  });

  it("a failing test file inside allowed_paths stays checks_failed", async () => {
    const f = await setup({ allowed: ["src/", "tests/"], repeated: false });
    await f.run();
    const [first] = await f.implementRuns();
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(grantTestsOf(first!.outcome)).toBeUndefined();
    expect(await f.grants()).toEqual([]);
    expect((await f.changes()).at(-1)).toMatchObject({ reason: "run_retry_scheduled" });
  });

  it("a failing test file that quotes no text the diff removed stays checks_failed", async () => {
    // The test asserts another string; the check still fails on the label change.
    const f = await setup({ test: `expect(label()).toBe("Unrelated words"); // ${OLD}\n`, repeated: false });
    await f.run();
    const [first] = await f.implementRuns();
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(grantTestsOf(first!.outcome)).toBeUndefined();
    expect(await f.grants()).toEqual([]);
    expect((await f.item()).allowed_paths).toEqual(["src/"]);
  });

  it("output that names no test file stays checks_failed", async () => {
    const f = await setup({ checks: [LINT], repeated: false });
    await f.run();
    const [first] = await f.implementRuns();
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(grantTestsOf(first!.outcome)).toBeUndefined();
    expect(await f.grants()).toEqual([]);
  });

  it("with auto_grant_test_paths off for the project (its own value, else the global one), stays checks_failed", async () => {
    for (const project of ["", config.project.key]) {
      const f = await setup({ repeated: false });
      if (project) await f.setOn("");
      await f.setOff(project);
      await f.run();
      const [first] = await f.implementRuns();
      expect(grantTestsOf(first!.outcome), project).toEqual([{ file: TEST, quotes: [OLD] }]);
      expect(await f.grants(), project).toEqual([]);
      expect((await f.item()).allowed_paths, project).toEqual(["src/"]);
      expect((await f.changes()).at(-1), project).toMatchObject({ reason: "run_retry_scheduled" });
    }
  });

  it("at most one automatic grant per item, counted with the needs-human grant: a checks_failed run after it stays checks_failed", async () => {
    // Run 1 asks for another test file (granted automatically); run 2 fails its checks on the label test.
    const f = await setup({
      repeated: false,
      implement: (_wd, n) => (n === 1 ? { output: { needs_human: { reason: "a test breaks", question: "allow it?", paths: ["tests/other.test.ts"] } } } : undefined),
    });
    await f.run();
    const runs = await f.implementRuns();
    expect(runs[1]!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(grantTestsOf(runs[1]!.outcome)).toEqual([{ file: TEST, quotes: [OLD] }]);
    const grants = await f.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.detail).toMatchObject({ run_id: runs[0]!.id });
    expect((await f.item()).allowed_paths).toEqual(["src/", "tests/other.test.ts"]);
    expect((await f.changes()).at(-1)).toMatchObject({ reason: "run_retry_scheduled" });
  });

  it("max_attempts still blocks before the grant", async () => {
    const f = await setup({ max_attempts: 1 });
    await f.run();
    expect(await f.grants()).toEqual([]);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
  });
});
